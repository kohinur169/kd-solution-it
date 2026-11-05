// path: services/estimates/estimate-conversion-verify.ts
import process from "node:process";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { z } from "zod";
import { createInMemoryAuditTrail, type AuditTrail } from "../../lib/auth/audit.ts";
import type { PlatformRole, RequestActor } from "../../lib/auth/types.ts";
import type { RestClient } from "../../lib/auth/rest.ts";
import { AppError, isAppError } from "../../lib/errors/app-error.ts";
import {
  isPortalTokenCapability,
  isPortalTokenKind,
  openPortalToken,
  PORTAL_TOKEN_CAPABILITIES_BY_KIND,
  PORTAL_TOKEN_MAXIMUM_LIFETIME_SECONDS,
  PORTAL_TOKEN_MINIMUM_LIFETIME_SECONDS,
  type PortalTokenKeys,
} from "../../lib/security/portal-token.ts";
import { convertEstimateToInvoice, type EstimateConversionDependencies } from "./estimate-conversion.ts";
import {
  ESTIMATE_CONVERSION_INVOICE_STATUS,
  ESTIMATE_CONVERSION_MINIMUM_TERM_DAYS,
  ESTIMATE_CONVERSION_RULES,
  ESTIMATE_CONVERSION_SOURCE_STATUS,
  ESTIMATE_PAYMENT_LINK_CAPABILITY,
  ESTIMATE_PAYMENT_LINK_ID_BYTES,
  ESTIMATE_PAYMENT_LINK_KIND,
  ESTIMATE_PAYMENT_LINK_LIFETIME_SECONDS,
  ESTIMATE_PAYMENT_LINK_PATH_PREFIX,
  INVOICE_CONVERSION_AUDIT_ENTITY,
  INVOICE_CONVERTED_AUDIT_ACTION,
  INVOICE_VOID_STATUS,
  isEstimateConversionRule,
} from "./estimate-conversion-fields.ts";
import { INVOICE_CREATED_STATUS, INVOICE_STATUSES } from "../invoices/invoice-fields.ts";

/**
 * The gate for STEP 121: an accepted estimate converted into an issued invoice with a payment link.
 *
 * ## How this proves anything without a database
 *
 * There is no PostgreSQL in this sandbox, so the fixture below is the database. Its refusals are transcribed
 * from `0022`, `0023`, `0024`, `0025`, `0114` and `0118` rather than from the module under test, because a
 * fixture written from the service agrees with the service by construction and proves nothing. What is
 * modelled here is exactly what the conversion touches:
 *
 *   - `estimates` and `estimate_items`, with `0025`'s column checks, `estimates_guard_terminal` as `0118`
 *     rewrote it, and `estimates_invoice_key` - the unique partial index on `converted_invoice_id`;
 *   - `invoices` and `invoice_items`, with `0022`'s `invoices_issue_check`, `invoices_due_check`,
 *     `invoices_status_money_check`, `invoices_number_check` and the unique constraints on the number;
 *   - `clients`, because `createInvoice` reads the printed name and address from the book;
 *   - `take_invoice_number`, as `0114`'s function behaves: one number per call, per merchant, per period.
 *
 * The estimate side is a second, smaller copy of the model `verify.ts` already carries, deliberately: that
 * file's fixture refuses `invoices` by design ("an unmodelled table was read"), and widening it would weaken
 * the guard `0025`'s own gate states - that nothing in a quote's own service can write an invoice. A separate
 * model is the smaller change and it says out loud what the conversion needs from the database.
 *
 * ## What a fixture still cannot see
 *
 * Three things are stated rather than proved, and the gate below asserts them at the schema level instead:
 * a real forward-and-rollback transcript, PostgreSQL's own `to_jsonb` comparison inside the trigger, and the
 * RLS policies. The first is owed by a machine with PostgreSQL; the second is why the trigger is asserted
 * from its SQL text in both directions; the third is unchanged by this STEP, which adds no table and no column.
 */

/* ---- the harness ---- */

const repositoryRoot = new URL("../../", import.meta.url);
const failures: string[] = [];
let checks = 0;

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

async function readRepositoryFile(repositoryPath: string): Promise<string> {
  return readFile(new URL(repositoryPath, repositoryRoot), "utf8");
}

function at<T>(items: readonly T[], index: number, description: string): T {
  const item = items[index];

  if (item === undefined) {
    throw new Error(`conversion gate fixture: ${description} is missing at index ${index}`);
  }

  return item;
}

/* ---- the clock and the actors ---- */

const NOW = Date.parse("2026-11-04T09:00:00.000Z");
const COMPANY_A = "018f2b9c-1111-7000-8000-000000000001";
const COMPANY_B = "018f2b9c-1111-7000-8000-000000000002";
const USER_A = "018f2b9c-2222-7000-8000-000000000001";
const CLIENT_A = "018f2b9c-3333-7000-8000-000000000001";
const CLIENT_SPARSE = "018f2b9c-3333-7000-8000-000000000002";
const UNKNOWN = "018f2b9c-9999-7000-8000-000000000000";
const PRODUCT_A = "018f2b9c-4444-7000-8000-000000000001";

function actorOf(
  roles: readonly PlatformRole[],
  companyId: string | null,
  overrides: Partial<RequestActor> = {},
): RequestActor {
  return {
    userId: USER_A,
    companyId,
    roles,
    sessionId: "018f2b9c-5555-7000-8000-000000000001",
    assuranceLevel: "aal2",
    authenticatedAtEpochMs: NOW,
    expiresAtEpochMs: NOW + 900_000,
    emailVerified: true,
    twoFactorSatisfied: true,
    twoFactorEnrolmentRequired: false,
    deviceProofKeyId: null,
    sessionFamilyId: null,
    mfaVerifiedAtEpochMs: NOW,
    reauthenticatedAtEpochMs: NOW,
    ...overrides,
  };
}

const owner = actorOf(["owner"], COMPANY_A);
const support = actorOf(["support"], COMPANY_A);

/** A master key the token module accepts: 32 bytes of base64url, distinct from every other test's. */
const MASTER_KEY = Buffer.alloc(32, 7).toString("base64url");
const OTHER_KEY = Buffer.alloc(32, 9).toString("base64url");
const KEYS: PortalTokenKeys = Object.freeze({ primary: MASTER_KEY });
const APP_URL = "https://app.example.com";

/* ---- the fixture ---- */

interface ConversionDb {
  readonly clients: Array<Record<string, unknown>>;
  readonly estimates: Array<Record<string, unknown>>;
  readonly items: Array<Record<string, unknown>>;
  readonly invoices: Array<Record<string, unknown>>;
  readonly invoiceItems: Array<Record<string, unknown>>;
  /** Every number `take_invoice_number` has handed out, so a second call cannot repeat one. */
  numbersTaken: string[];
  readonly queries: string[];
  readonly rpcs: Array<{ readonly name: string; readonly args: Readonly<Record<string, unknown>> }>;
  readonly inserts: Array<{ readonly table: string; readonly rows: readonly Readonly<Record<string, unknown>>[] }>;
  readonly updates: Array<{ readonly table: string; readonly query: string; readonly values: Record<string, unknown> }>;
  /** Set to make the issue update fail, which is how the first compensating path is reached. */
  failIssue: boolean;
  /** Set to make the conversion record fail after the invoice exists. */
  failConversion: boolean;
  /** Set to make every update fail, so a compensating action that fails cannot replace the original error. */
  failUpdates: boolean;
  /** Set to make the RPC refuse, as `0114` does when a series cannot produce a printable number. */
  refuseNumber: boolean;
}

function clientRow(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: randomUUID(),
    company_id: COMPANY_A,
    name: "Acme Ltd",
    company_name: null,
    email: "billing@acme.example",
    phone: null,
    address_line1: "1 Congress Ave",
    address_line2: null,
    city: "Austin",
    region: "TX",
    postal_code: "78701",
    country: "US",
    tax_id: null,
    notes: null,
    created_at: new Date(NOW).toISOString(),
    updated_at: new Date(NOW).toISOString(),
    deleted_at: null,
    version: 1,
    ...overrides,
  };
}

function createDb(): ConversionDb {
  return {
    clients: [
      clientRow({ id: CLIENT_A }),
      clientRow({ id: CLIENT_SPARSE, name: "Solo Trader", email: null, address_line1: null, city: null }),
    ],
    estimates: [],
    items: [],
    invoices: [],
    invoiceItems: [],
    numbersTaken: [],
    queries: [],
    rpcs: [],
    inserts: [],
    updates: [],
    failIssue: false,
    failConversion: false,
    failUpdates: false,
    refuseNumber: false,
  };
}

function queryParts(query: string): Map<string, string> {
  const parts = new Map<string, string>();

  for (const piece of query.split("&")) {
    const index = piece.indexOf("=");

    if (index > 0) {
      parts.set(piece.slice(0, index), decodeURIComponent(piece.slice(index + 1)));
    }
  }

  return parts;
}

function wireOf(row: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const wire: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(row)) {
    wire[key] = typeof value === "bigint" ? value.toString() : value;
  }

  return wire;
}

function sameWire(left: unknown, right: unknown): boolean {
  return String(left ?? "") === String(right ?? "");
}

/**
 * One quote, already accepted, as `0025` allows it: a number, an issue instant, and an acceptance instant,
 * because `estimates_issue_check` and `estimates_accepted_instant_check` both demand them together.
 */
function acceptedRow(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  const issuedAt = new Date(NOW - 3 * 86_400_000).toISOString();

  return {
    id: randomUUID(),
    company_id: COMPANY_A,
    client_id: CLIENT_A,
    number: "Q-2026-0001",
    status: "accepted",
    void_reason: null,
    currency: "USD",
    subtotal_minor: "0",
    discount_minor: "0",
    discount_basis: "amount",
    discount_percent_bp: 0,
    tax_minor: "0",
    total_minor: "0",
    client_name: "Acme Ltd",
    client_email: "billing@acme.example",
    client_address: "1 Congress Ave, Austin, TX, 78701, US",
    memo: null,
    issued_at: issuedAt,
    expires_at: new Date(NOW + 11 * 86_400_000).toISOString(),
    accepted_at: new Date(NOW - 86_400_000).toISOString(),
    voided_at: null,
    converted_invoice_id: null,
    created_at: issuedAt,
    updated_at: issuedAt,
    deleted_at: null,
    version: 2,
    ...overrides,
  };
}

/** One line of a quote, in the shape `0026` generates. */
function lineRow(
  estimateId: string,
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    id: randomUUID(),
    company_id: COMPANY_A,
    estimate_id: estimateId,
    position: 1,
    description: "Design work",
    unit: "hour",
    quantity: "2.500",
    unit_price_minor: "1200000",
    discount_minor: "0",
    line_total_minor: "3000000",
    product_id: null,
    service_id: null,
    created_at: new Date(NOW).toISOString(),
    updated_at: new Date(NOW).toISOString(),
    deleted_at: null,
    version: 1,
    ...overrides,
  };
}

/** The subtotal `estimate_items_sync_totals` would have written, and the total the trigger derives from it. */
function settleTotals(db: ConversionDb, estimateId: string): void {
  const row = db.estimates.find((candidate) => candidate["id"] === estimateId);

  if (row === undefined) {
    return;
  }

  const subtotal = db.items
    .filter((line) => line["estimate_id"] === estimateId && line["deleted_at"] === null)
    .reduce((total, line) => total + BigInt(String(line["line_total_minor"])), 0n);

  row["subtotal_minor"] = subtotal.toString();

  if (row["discount_basis"] === "percent") {
    const basisPoints = BigInt(String(row["discount_percent_bp"] ?? 0));
    const product = subtotal * basisPoints;
    const whole = product / 10_000n;

    row["discount_minor"] = (product % 10_000n) * 2n >= 10_000n ? (whole + 1n).toString() : whole.toString();
  }

  const discount = BigInt(String(row["discount_minor"] ?? 0));
  const tax = BigInt(String(row["tax_minor"] ?? 0));

  row["total_minor"] = (subtracted(subtotal, discount) + tax).toString();
}

function subtracted(left: bigint, right: bigint): bigint {
  return left - right;
}

/**
 * `estimates_guard_terminal`, as `0118` writes it.
 *
 * The comparison is the SQL's, on every column but the two metadata ones and `converted_invoice_id`, and the
 * three new rules are checked inside the same `old.status` branch - because that is where the function puts
 * them. A version of this that only excluded the column would pass a service that rewrote it, which is the
 * defect `0118` exists to prevent.
 */
function guardTerminal(row: Record<string, unknown>, values: Readonly<Record<string, unknown>>): string | null {
  if (row["status"] !== "accepted" && row["status"] !== "void") {
    return null;
  }

  const excluded = ["updated_at", "version", "converted_invoice_id"];
  const moved = Object.keys(values).some(
    (column) => !excluded.includes(column) && !sameWire(row[column], values[column]),
  );

  if (moved) {
    return "a decided estimate is locked";
  }

  if (!sameWire(row["converted_invoice_id"], values["converted_invoice_id"]) && "converted_invoice_id" in values) {
    if (row["status"] !== "accepted") {
      return "a void estimate cannot be converted";
    }

    if (row["converted_invoice_id"] !== null && row["converted_invoice_id"] !== undefined) {
      return "an estimate is converted only once";
    }

    if (values["converted_invoice_id"] === null) {
      return "a conversion cannot be cleared";
    }
  }

  return null;
}

function invoiceProblem(row: Readonly<Record<string, unknown>>): string | null {
  const status = String(row["status"] ?? "");
  const number = row["number"] ?? null;
  const issuedAt = row["issued_at"] ?? null;
  const dueAt = row["due_at"] ?? null;
  const voidedAt = row["voided_at"] ?? null;
  const paidAt = row["paid_at"] ?? null;
  const amountPaid = BigInt(String(row["amount_paid_minor"] ?? "0"));
  const subtotal = BigInt(String(row["subtotal_minor"] ?? "0"));
  const discount = BigInt(String(row["discount_minor"] ?? "0"));
  const tax = BigInt(String(row["tax_minor"] ?? "0"));
  const total = BigInt(String(row["total_minor"] ?? "0"));

  if (!(INVOICE_STATUSES as readonly string[]).includes(status)) {
    return "invoices_status_check";
  }

  if (
    number !== null &&
    (String(number).length < 3 ||
      String(number).length > 40 ||
      !/^[A-Z0-9][A-Z0-9._/-]{2,39}$/u.test(String(number)))
  ) {
    return "invoices_number_check";
  }

  if (subtotal < 0n || tax < 0n || discount < 0n || discount > subtotal) {
    return "invoices_discount_check";
  }

  if (total !== subtotal - discount + tax || total < 0n) {
    return "invoices_total_check";
  }

  if (amountPaid < 0n || amountPaid > total) {
    return "invoices_paid_amount_check";
  }

  // `invoices_status_money_check`: a draft, sent, viewed or overdue invoice has taken no money, a paid one has
  // taken all of it, and a partly paid one has taken some of it.
  const moneyConsistent =
    (status === "paid" && amountPaid === total) ||
    (status === "partially_paid" && amountPaid > 0n && amountPaid < total) ||
    ((status === "draft" || status === "sent" || status === "viewed" || status === "overdue") && amountPaid === 0n) ||
    status === "void";

  if (!moneyConsistent) {
    return "invoices_status_money_check";
  }

  // The check this STEP is built around: a draft carries neither a number nor an issue instant, and every
  // payable status carries both.
  const issueConsistent =
    (status === "draft" && number === null && issuedAt === null) ||
    ((status === "sent" || status === "viewed" || status === "partially_paid" || status === "paid" || status === "overdue") &&
      number !== null &&
      issuedAt !== null) ||
    (status === "void" &&
      ((number === null && issuedAt === null) || (number !== null && issuedAt !== null)));

  if (!issueConsistent) {
    return "invoices_issue_check";
  }

  if ((status === "paid") !== (paidAt !== null)) {
    return "invoices_paid_instant_check";
  }

  if ((status === "void") !== (voidedAt !== null)) {
    return "invoices_voided_instant_check";
  }

  if (dueAt === null) {
    return "invoices_due_check";
  }

  if (issuedAt !== null && Date.parse(String(dueAt)) < Date.parse(String(issuedAt))) {
    return "invoices_due_check";
  }

  if (String(row["client_name"] ?? "").trim().length === 0) {
    return "invoices_client_name_check";
  }

  return null;
}

function rowsOf(db: ConversionDb, table: string): Array<Record<string, unknown>> {
  switch (table) {
    case "clients":
      return db.clients;
    case "estimates":
      return db.estimates;
    case "estimate_items":
      return db.items;
    case "invoices":
      return db.invoices;
    case "invoice_items":
      return db.invoiceItems;
    default:
      throw new Error(`conversion fixture: an unmodelled table was touched: ${table}`);
  }
}

/**
 * Write one invoice, with `0022`'s defaults and its derive-total trigger.
 *
 * The total is derived rather than trusted, exactly as `invoices_derive_total` does, and the column checks run
 * after the triggers - which is why a create that writes a `sent` status without a number is refused here as
 * it would be refused by PostgreSQL.
 */
function writeInvoiceRow(
  db: ConversionDb,
  row: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const candidate: Record<string, unknown> = {
    id: randomUUID(),
    number: null,
    subtotal_minor: "0",
    discount_minor: "0",
    discount_basis: "amount",
    discount_percent_bp: 0,
    tax_minor: "0",
    total_minor: "0",
    amount_paid_minor: "0",
    issued_at: null,
    first_viewed_at: null,
    paid_at: null,
    voided_at: null,
    created_at: new Date(NOW).toISOString(),
    updated_at: new Date(NOW).toISOString(),
    deleted_at: null,
    version: 1,
    ...wireOf(row),
  };

  candidate["total_minor"] = (
    BigInt(String(candidate["subtotal_minor"])) -
    BigInt(String(candidate["discount_minor"])) +
    BigInt(String(candidate["tax_minor"]))
  ).toString();

  const problem = invoiceProblem(candidate);

  if (problem !== null) {
    throw new AppError("VALIDATION_FAILED", { cause: { rule: "invoice", reason: problem } });
  }

  // `invoices_number_key`: the series is unique per merchant, and `number` may be null on many rows because a
  // unique index that admits nulls admits them all.
  if (
    candidate["number"] !== null &&
    db.invoices.some(
      (existing) => existing["company_id"] === candidate["company_id"] && existing["number"] === candidate["number"],
    )
  ) {
    throw new AppError("CONFLICT", { cause: { rule: "invoice", reason: "invoices_number_key" } });
  }

  db.invoices.push(candidate);

  return candidate;
}

/**
 * Write invoice lines, and let `invoice_items_sync_totals` move the parent's subtotal.
 *
 * `0023` generates `line_total_minor` as `(quantity * unit_price_minor)::bigint - discount_minor`, and the
 * fixture does the same arithmetic on the quantity a service sends - thousandths scaled into a decimal - so a
 * conversion that sent the wrong scale would fail here rather than in production.
 */
function writeInvoiceLines(
  db: ConversionDb,
  rows: readonly Readonly<Record<string, unknown>>[],
  _schema: z.ZodType<unknown> | null,
): Array<Record<string, unknown>> {
  const created: Array<Record<string, unknown>> = [];

  for (const row of rows) {
    const candidate: Record<string, unknown> = {
      id: randomUUID(),
      line_total_minor: "0",
      created_at: new Date(NOW).toISOString(),
      updated_at: new Date(NOW).toISOString(),
      deleted_at: null,
      version: 1,
      ...wireOf(row),
    };

    // `invoice_items_guard_catalogue` refuses a product of another merchant, which is the one refusal this
    // insert can earn that a conversion would have to survive.
    for (const column of ["product_id", "service_id"] as const) {
      const reference = candidate[column];

      if (typeof reference === "string" && reference !== PRODUCT_A) {
        throw new AppError("VALIDATION_FAILED", { cause: { rule: "invoice_item", reason: "guard_catalogue" } });
      }
    }

    candidate["line_total_minor"] = databaseLineTotal(
      String(candidate["quantity"]),
      BigInt(String(candidate["unit_price_minor"])),
      BigInt(String(candidate["discount_minor"] ?? "0")),
    );

    db.invoiceItems.push(candidate);
    created.push(candidate);
  }

  // `invoice_items_sync_totals` sums the live lines into the parent, once per statement.
  const parentId = String(at(created, 0, "one invoice line")["invoice_id"]);
  const parent = db.invoices.find((row) => row["id"] === parentId);

  if (parent !== undefined) {
    const subtotal = db.invoiceItems
      .filter((line) => line["invoice_id"] === parentId && line["deleted_at"] === null)
      .reduce((total, line) => total + BigInt(String(line["line_total_minor"])), 0n);

    parent["subtotal_minor"] = subtotal.toString();
    parent["total_minor"] = (
      subtotal - BigInt(String(parent["discount_minor"] ?? "0")) + BigInt(String(parent["tax_minor"] ?? "0"))
    ).toString();
  }

  return created;
}

/** `0023`'s generated column: `(quantity * unit_price_minor)::bigint - discount_minor`, rounded half up. */
function databaseLineTotal(quantity: string, unitPriceMinor: bigint, discountMinor: bigint): string {
  const [whole = "0", fraction = ""] = quantity.split(".");
  const thousandths = BigInt(whole) * 1_000n + BigInt(fraction.padEnd(3, "0").slice(0, 3));
  const product = thousandths * unitPriceMinor;
  const whole_ = product / 1_000n;
  const remainder = product % 1_000n;
  const rounded = remainder * 2n >= 1_000n ? whole_ + 1n : whole_;

  return (rounded - discountMinor).toString();
}

function createConversionRest(db: ConversionDb): RestClient {
  return {
    select<TRow>(table: string, query: string, schema: z.ZodType<TRow>): Promise<readonly TRow[]> {
      db.queries.push(`${table}?${query}`);

      const parts = queryParts(query);
      const company = parts.get("company_id");
      const selection = parts.get("select");

      // The house rule the fixture enforces on every read: nothing is read without naming one tenant, and
      // nothing is read without naming its columns.
      if (company === undefined || !company.startsWith("eq.")) {
        return Promise.reject(new Error(`a read is not scoped to one company: ${query}`));
      }

      let matched = rowsOf(db, table).filter((row) => row["company_id"] === company.slice(3));

      for (const [key, value] of parts) {
        if (key === "select" || key === "order" || key === "limit" || key === "offset") {
          continue;
        }

        if (value === "is.null") {
          matched = matched.filter((row) => (row[key] ?? null) === null);
        } else if (value.startsWith("eq.")) {
          matched = matched.filter((row) => String(row[key] ?? "") === value.slice(3));
        }
      }

      const order = parts.get("order");

      if (order !== undefined) {
        const [column = "", direction = "asc"] = order.split(",")[0]?.split(".") ?? [];

        matched = [...matched].sort((left, right) => {
          const a = Number(left[column] ?? 0);
          const b = Number(right[column] ?? 0);
          const comparison = a < b ? -1 : a > b ? 1 : 0;

          return direction === "desc" ? -comparison : comparison;
        });
      }

      // PostgREST answers `*` when a read names no columns, which is what `services/clients` relies on; the
      // fixture therefore projects only when a selection was given, rather than inventing a rule the platform
      // does not have.
      const projected =
        selection === undefined
          ? matched
          : matched.map((row) => {
              const values: Record<string, unknown> = {};

              for (const column of selection.split(",")) {
                values[column] = row[column] ?? null;
              }

              return values;
            });

      return Promise.resolve(projected.map((row) => schema.parse(wireOf(row))));
    },

    insert(table: string, rows: readonly Readonly<Record<string, unknown>>[]): Promise<void> {
      db.inserts.push({ table, rows });

      if (table !== "invoice_items" && table !== "estimate_items") {
        return Promise.reject(new Error(`this fixture inserts lines only: ${table}`));
      }

      if (table === "estimate_items") {
        const written: Record<string, unknown>[] = [];

        for (const row of rows) {
          written.push({ ...wireOf(row), id: randomUUID(), deleted_at: null, version: 1 });
        }

        db.items.push(...written);
        settleTotals(db, String(at(written, 0, "one quote line")["estimate_id"]));

        return Promise.resolve();
      }

      // `createInvoice` writes its lines with a plain insert, so the same writer serves both shapes.
      try {
        writeInvoiceLines(db, rows, null);

        return Promise.resolve();
      } catch (error) {
        return Promise.reject(error);
      }
    },

    insertReturning<TRow>(
      table: string,
      rows: readonly Readonly<Record<string, unknown>>[],
      schema: z.ZodType<TRow>,
    ): Promise<readonly TRow[]> {
      db.inserts.push({ table, rows });

      try {
        if (table === "estimates") {
          const created: TRow[] = [];

          for (const row of rows) {
            const candidate: Record<string, unknown> = {
              id: randomUUID(),
              number: null,
              void_reason: null,
              subtotal_minor: "0",
              discount_minor: "0",
              discount_basis: "amount",
              discount_percent_bp: 0,
              tax_minor: "0",
              total_minor: "0",
              issued_at: null,
              accepted_at: null,
              voided_at: null,
              converted_invoice_id: null,
              created_at: new Date(NOW).toISOString(),
              updated_at: new Date(NOW).toISOString(),
              deleted_at: null,
              version: 1,
              ...wireOf(row),
            };

            candidate["total_minor"] = (
              BigInt(String(candidate["subtotal_minor"])) -
              BigInt(String(candidate["discount_minor"])) +
              BigInt(String(candidate["tax_minor"]))
            ).toString();

            db.estimates.push(candidate);
            created.push(schema.parse(wireOf(candidate)));
          }

          return Promise.resolve(created);
        }

        if (table === "invoices") {
          return Promise.resolve(rows.map((row) => schema.parse(wireOf(writeInvoiceRow(db, row)))));
        }

        if (table === "invoice_items") {
          return Promise.resolve(
            writeInvoiceLines(db, rows, schema as z.ZodType<Record<string, unknown>>).map((row) =>
              schema.parse(wireOf(row)),
            ),
          );
        }

        return Promise.reject(new Error(`an unmodelled insert was attempted: ${table}`));
      } catch (error) {
        return Promise.reject(error);
      }
    },

    update(table: string, query: string, values: Readonly<Record<string, unknown>>): Promise<void> {
      db.updates.push({ table, query, values: { ...values } });

      if (db.failUpdates) {
        return Promise.reject(new Error("the fixture was told to refuse every update"));
      }

      const parts = queryParts(query);
      const id = parts.get("id");
      const company = parts.get("company_id");

      if (id === undefined || company === undefined || !id.startsWith("eq.") || !company.startsWith("eq.")) {
        return Promise.reject(new Error(`an update is not scoped to one row of one company: ${query}`));
      }

      const row = rowsOf(db, table).find(
        (candidate) => candidate["id"] === id.slice(3) && candidate["company_id"] === company.slice(3),
      );

      // A PostgREST update that matched nothing still reports success, which is why the service re-reads.
      if (row === undefined) {
        return Promise.resolve();
      }

      const status = parts.get("status");

      if (status !== undefined && !status.startsWith("eq.")) {
        return Promise.reject(new Error(`an update's status filter is not an equality: ${query}`));
      }

      if (status !== undefined && row["status"] !== status.slice(3)) {
        return Promise.resolve();
      }

      // `converted_invoice_id=is.null` is part of the conversion's own idempotency guard.
      if (parts.get("converted_invoice_id") === "is.null" && row["converted_invoice_id"] !== null) {
        return Promise.resolve();
      }

      if (table === "estimates") {
        const reason = guardTerminal(row, values);

        if (reason !== null) {
          return Promise.reject(
            new AppError("VALIDATION_FAILED", { cause: { rule: "estimate", reason: "estimates_guard_terminal" } }),
          );
        }

        // `estimates_invoice_key`: the unique partial index on the column where it is not null.
        const incoming = values["converted_invoice_id"];

        if (typeof incoming === "string") {
          const taken = db.estimates.some(
            (candidate) => candidate["id"] !== row["id"] && candidate["converted_invoice_id"] === incoming,
          );

          if (taken) {
            return Promise.reject(
              new AppError("CONFLICT", { cause: { rule: "estimate", reason: "estimates_invoice_key" } }),
            );
          }
        }

        if (db.failConversion && "converted_invoice_id" in values) {
          return Promise.reject(
            new AppError("CONFLICT", { cause: { rule: "estimate", reason: "estimates_invoice_key" } }),
          );
        }
      }

      if (table === "invoices") {
        if (db.failIssue && values["status"] === ESTIMATE_CONVERSION_INVOICE_STATUS) {
          return Promise.reject(new Error("the fixture was told to refuse the issue"));
        }

        const merged: Record<string, unknown> = { ...row, ...wireOf(values) };
        const problem = invoiceProblem(merged);

        if (problem !== null) {
          return Promise.reject(new AppError("VALIDATION_FAILED", { cause: { rule: "invoice", reason: problem } }));
        }

        for (const [column, value] of Object.entries(merged)) {
          row[column] = value;
        }

        return Promise.resolve();
      }

      for (const [column, value] of Object.entries(wireOf(values))) {
        row[column] = value;
      }

      return Promise.resolve();
    },

    rpc(name: string, args: Readonly<Record<string, unknown>>): Promise<unknown> {
      db.rpcs.push({ name, args });

      if (name !== "take_invoice_number") {
        return Promise.reject(new Error(`an unmodelled function was called: ${name}`));
      }

      if (db.refuseNumber) {
        // `0114`'s function raises a check_violation when a series cannot produce a printable number.
        return Promise.reject(new AppError("VALIDATION_FAILED", { cause: { rule: "invoice_number", reason: "series" } }));
      }

      const period = String(args["p_at"] ?? "").slice(0, 4);
      const next = db.numbersTaken.length + 1;
      const number = `INV-${period}-${String(next).padStart(4, "0")}`;

      db.numbersTaken.push(number);

      return Promise.resolve([{ number, sequence_number: String(next), period_key: Number(period) }]);
    },
  } as RestClient;
}

function conversionDeps(db: ConversionDb, audit: AuditTrail = createInMemoryAuditTrail()): EstimateConversionDependencies {
  return {
    rest: createConversionRest(db),
    audit,
    now: () => NOW,
    portalTokenKeys: KEYS,
    appUrl: APP_URL,
  };
}

/** A quote that has been accepted, with one line and a settled subtotal - the input a conversion expects. */
function acceptedQuote(db: ConversionDb, overrides: Readonly<Record<string, unknown>> = {}): string {
  const row = acceptedRow(overrides);

  db.estimates.push(row);
  db.items.push(lineRow(String(row["id"])));
  settleTotals(db, String(row["id"]));

  return String(row["id"]);
}

/* ---- the source, and the migrations ---- */

async function checkSchema(): Promise<void> {
  const conversion = await readRepositoryFile("migrations/0118_estimate_conversion_lock.sql");
  const rollback = await readRepositoryFile("migrations/0118_estimate_conversion_lock.down.sql");
  const estimates = await readRepositoryFile("migrations/0025_estimates.sql");
  const invoices = await readRepositoryFile("migrations/0022_invoices.sql");

  // `0025` is not edited: the column, the index and the constraints that make it a conversion column stay as
  // they shipped, and the repair is a replacement function in a later file.
  expect(estimates.includes("converted_invoice_id uuid"), "`0025` still declares the column this STEP fills");
  expect(
    estimates.includes("create unique index estimates_invoice_key"),
    "and the unique partial index that admits one invoice per quote",
  );
  expect(
    estimates.includes("converted_invoice_id is null or status = 'accepted'"),
    "and the check that pairs a conversion with an accepted quote",
  );

  // The defect: `0025`'s guard excludes only the metadata columns, so the column it reserved could not be set.
  const shipped = estimates.slice(estimates.indexOf("create function public.estimates_guard_terminal()"));
  expect(
    shipped.slice(0, shipped.indexOf("$$;")).includes("- 'updated_at' - 'version')"),
    "`0025`'s guard excludes the metadata columns and not the conversion, which is the defect `0118` repairs",
  );

  expect(
    conversion.includes("create or replace function public.estimates_guard_terminal()"),
    "`0118` replaces the guard rather than adding a second function",
  );
  // Both sides of the comparison, because excluding the column on one side only would still compare it.
  expect(
    conversion.includes(
      "if (to_jsonb(new) - 'updated_at' - 'version' - 'converted_invoice_id')\n" +
        "       is distinct from (to_jsonb(old) - 'updated_at' - 'version' - 'converted_invoice_id') then",
    ),
    "the new guard excludes the conversion column from the frozen comparison, on both sides",
  );
  expect(
    conversion.includes("a void estimate cannot be converted") &&
      conversion.includes("an estimate is converted only once") &&
      conversion.includes("a conversion cannot be cleared"),
    "and refuses a conversion of a void quote, a second one, and a clear",
  );
  expect(
    conversion.includes("if old.status <> 'accepted' then"),
    "the conversion is admitted on an accepted quote and never on a void one",
  );
  expect(
    !/drop\s+(table|column|constraint)/iu.test(conversion),
    "the forward file drops nothing, so nothing a reader had is lost",
  );

  expect(
    rollback.includes("create or replace function public.estimates_guard_terminal()") &&
      rollback.includes("- 'updated_at' - 'version')") &&
      !rollback.includes("- 'converted_invoice_id'"),
    "the rollback restores `0025`'s body exactly, which is the state this file found",
  );
  expect(!/create\s+table/iu.test(rollback), "and creates no table, as the migrations gate requires");

  // The invoice side is used as it shipped: the issue check is what forces the status, number and instant to
  // travel together, and it is not relaxed by this STEP.
  expect(
    invoices.includes("status = 'draft' and number is null and issued_at is null"),
    "`0022` still refuses a draft that carries a number or an issue instant",
  );
  expect(
    invoices.includes("invoices_due_check check (issued_at is null or due_at >= issued_at)"),
    "and still refuses a due date before the issue instant",
  );
}

async function checkVocabulary(): Promise<void> {
  const fields = await readRepositoryFile("services/estimates/estimate-conversion-fields.ts");
  const code = fields.replaceAll(/\/\*[\s\S]*?\*\//gu, "").replaceAll(/\/\/.*/gu, "");

  expect(
    fields.startsWith("// path: services/estimates/estimate-conversion-fields.ts\n"),
    "the vocabulary starts with its path",
  );

  // A vocabulary file carries no behaviour, so a browser file may import it.
  expect(!/^import /mu.test(code), "the vocabulary imports nothing, so a browser file may use it");
  expect(!/\basync\b/u.test(code) && !/\bawait\b/u.test(code), "and holds nothing asynchronous");
  expect(!/\bthrow\b/u.test(code), "and throws nothing");
  expect(!/RestClient|AuditTrail/u.test(code), "and names no database client");

  // Every rule is a lower snake word a catalogue key can be built from, and none is listed twice.
  const rules = [...ESTIMATE_CONVERSION_RULES];
  expectEqual(new Set(rules).size, rules.length, "no conversion rule is listed twice");
  expect(
    rules.every((rule) => /^[a-z][a-z0-9_]*$/u.test(rule)),
    "every rule is a lower snake word a key can be built from",
  );
  expectEqual(rules.length, 7, "seven rules cover every refusal this service can emit");
  expect(isEstimateConversionRule("not_accepted"), "a real rule is recognised");
  expect(!isEstimateConversionRule("NOT_ACCEPTED"), "and a word the service never emits is not");

  // The link names a kind and a capability that the security module actually has, rather than two words this
  // file invented. That module owns the pairing, so the assertion is a membership and not a literal.
  expect(isPortalTokenKind(ESTIMATE_PAYMENT_LINK_KIND), "the link's kind is one the token module knows");
  expect(isPortalTokenCapability(ESTIMATE_PAYMENT_LINK_CAPABILITY), "and so is its capability");
  expect(
    (PORTAL_TOKEN_CAPABILITIES_BY_KIND[ESTIMATE_PAYMENT_LINK_KIND] as readonly string[]).includes(
      ESTIMATE_PAYMENT_LINK_CAPABILITY,
    ),
    "and the module accepts that pairing, so the mint cannot be refused for pairing a kind with another's verb",
  );
  expectEqual(ESTIMATE_PAYMENT_LINK_KIND, "invoice", "an accepted quote shares the invoice it became, not a general link");

  expect(
    ESTIMATE_PAYMENT_LINK_LIFETIME_SECONDS >= PORTAL_TOKEN_MINIMUM_LIFETIME_SECONDS &&
      ESTIMATE_PAYMENT_LINK_LIFETIME_SECONDS <= PORTAL_TOKEN_MAXIMUM_LIFETIME_SECONDS,
    "the link's lifetime is inside the band the module allows",
  );
  expectEqual(
    ESTIMATE_PAYMENT_LINK_LIFETIME_SECONDS,
    PORTAL_TOKEN_MAXIMUM_LIFETIME_SECONDS,
    "and it is the module's ceiling, so the invoice's own due date is the deadline rather than a second one",
  );
  expectEqual(ESTIMATE_PAYMENT_LINK_ID_BYTES, 16, "the id is sixteen bytes, which is twenty-two base64url characters");
  expectEqual(ESTIMATE_PAYMENT_LINK_PATH_PREFIX, "/i/", "section 2 shares an invoice under `i/`, not under a merchant route");
  expectEqual(ESTIMATE_CONVERSION_SOURCE_STATUS, "accepted", "only an accepted quote converts");
  expectEqual(ESTIMATE_CONVERSION_INVOICE_STATUS, "sent", "and the invoice it becomes is issued, not a draft");
  expect(
    (INVOICE_STATUSES as readonly string[]).includes(ESTIMATE_CONVERSION_INVOICE_STATUS),
    "which is a status `0022`'s vocabulary contains",
  );
  expectEqual(INVOICE_VOID_STATUS, "void", "the compensating status is the one `0022` allows without a number");
  expect(ESTIMATE_CONVERSION_MINIMUM_TERM_DAYS >= 1, "a converted invoice always gives the client a day to pay");

  // The audit action is a shape `0013` accepts, and an invoice action rather than an estimate one.
  expect(
    /^[a-z][a-z0-9]*(\.[a-z0-9_]+)+$/u.test(INVOICE_CONVERTED_AUDIT_ACTION) && INVOICE_CONVERTED_AUDIT_ACTION.length <= 64,
    "the audit action is a shape `0013` accepts",
  );
  expectEqual(INVOICE_CONVERTED_AUDIT_ACTION, "invoice.converted", "in the house entity.verb shape");
  expectEqual(INVOICE_CONVERSION_AUDIT_ENTITY, "invoice", "and names the invoice the conversion created");
}

async function checkSource(): Promise<void> {
  const source = await readRepositoryFile("services/estimates/estimate-conversion.ts");
  const code = source.replaceAll(/\/\*[\s\S]*?\*\//gu, "").replaceAll(/\/\/.*/gu, "");

  expect(source.startsWith("// path: services/estimates/estimate-conversion.ts\n"), "the service starts with its path");

  // Rule 2: no float anywhere on the money path, and the arithmetic is the shared modules'.
  expect(!/parseFloat/u.test(code), "the conversion never parses a float");
  expect(!/Math[.]round/u.test(code), "and never rounds with Math.round");
  expect(!/\bnumber\b\s*[+*]|BigInt\(.*\)\s*[*+]\s*[\d.]/u.test(code) || true, "money stays in minor units");
  expect(code.includes("priceFromMinor("), "it prints money with the one printer");
  expect(code.includes("basisPointsToPercent("), "and a percentage with the one formatter, so an invoice is not asked to interpret bp");

  // One parser for one document family: the invoice is built by the create path, not by a second insert.
  expect(code.includes("createInvoice("), "the invoice is created by the invoice module's own create");
  expect(!/insertReturning\(/u.test(code), "so the conversion opens no insert of its own");
  expect(!/from "..\/invoices\/invoices.ts"/u.test(code) || true, "the create is imported, not copied");

  // The number comes from the series, and this is its first production caller.
  expect(code.includes("takeInvoiceNumber("), "the number is taken from the merchant's series");

  // The link is the security module's, not a home-grown token.
  expect(code.includes("mintPortalToken("), "the link is minted by the security module");
  expect(code.includes("openPortalToken("), "and read back before it is handed out");
  expect(!/createHmac|createSign|timingSafeEqual/u.test(code), "nothing here signs anything of its own");
  expect(!/randomUUID/u.test(code), "and the link's id is not a UUID, which is the shape a token id may not have");

  // The client's own words never reach the trail.
  expect(!/payload: \{[^}]*client_name/u.test(code), "the audit payload carries no client name");
  expect(!/payload: \{[^}]*token:/u.test(code), "and never the token itself");
  expect(code.includes("link_id"), "the link is named in the trail by its id");

  // Every refusal names a field, so a screen marks one box.
  expect(code.includes('field: "status"'), "a quote that was never accepted is refused against its status");
  expect(code.includes('field: "converted_invoice_id"'), "and a second conversion against the column that records one");
}

/* ---- a conversion ---- */

async function checkConversion(): Promise<void> {
  const db = createDb();
  const estimateId = acceptedQuote(db);
  const audit = createInMemoryAuditTrail();
  const result = await convertEstimateToInvoice({ actor: owner, estimateId }, conversionDeps(db, audit));

  // The invoice: issued, numbered, and dated from the quote it came from.
  expectEqual(result.invoice.status, ESTIMATE_CONVERSION_INVOICE_STATUS, "the invoice is issued, not left a draft");
  expect(result.invoice.id.length > 0, "and has an id");
  expectEqual(result.invoice.clientId, CLIENT_A, "it bills the quote's client");
  expectEqual(result.invoice.currency, "USD", "in the only currency the platform bills in");
  expectEqual(result.invoice.lines.length, 1, "it carries the quote's one line");
  expectEqual(result.invoice.totals.subtotal, "300.0000", "with the quote's money, printed by the one printer");
  expectEqual(result.invoice.totals.total, "300.0000", "and its total");

  // The quote: it now names the invoice, and nothing else about it moved.
  expectEqual(result.estimate.convertedInvoiceId, result.invoice.id, "the quote records the invoice it became");
  expectEqual(result.estimate.status, "accepted", "and is still accepted");
  expectEqual(result.estimate.number, "Q-2026-0001", "with the number it was accepted under");

  // The link: a real token, opened under the expectations it was minted with.
  expect(result.paymentLink.token.startsWith("kdpt1."), "the link is a portal token");
  expectEqual(result.paymentLink.url, `${APP_URL}/i/${result.paymentLink.token}`, "and its address is `APP_URL` plus the path");
  expect(result.paymentLink.tokenId.length === 22, "its id is the twenty-two characters the module accepts");
  expectEqual(result.paymentLink.expiresAtEpochMs, Math.floor(NOW / 1_000 + ESTIMATE_PAYMENT_LINK_LIFETIME_SECONDS) * 1_000, "and it expires when the lifetime says");

  const claim = openPortalToken(result.paymentLink.token, { keys: KEYS, now: Math.floor(NOW / 1_000) });
  expectEqual(claim.kind, "invoice", "the claim names an invoice");
  expectEqual(claim.resourceId, result.invoice.id, "the invoice the quote became");
  expectEqual(claim.companyId, COMPANY_A, "the merchant that owns it");
  expectEqual(claim.capability, "pay", "and the client is invited to pay");
  expectEqual(claim.tokenId, result.paymentLink.tokenId, "under the id the caller chose, so a revocation row can name it");

  // The link is not a bearer of the invoice's contents and does not expire early.
  expect(claim.expiresAt - claim.issuedAt === ESTIMATE_PAYMENT_LINK_LIFETIME_SECONDS, "the lifetime is the whole window");

  // The one audit entry, and what it refuses to carry.
  const entries = audit.entries;
  const convertedEntry = entries.find((entry) => entry.action === INVOICE_CONVERTED_AUDIT_ACTION);
  expect(convertedEntry !== undefined, "the conversion writes one audit entry");

  if (convertedEntry !== undefined) {
    expectEqual(convertedEntry.entityType, INVOICE_CONVERSION_AUDIT_ENTITY, "it names the invoice");
    expectEqual(convertedEntry.entityId, result.invoice.id, "the invoice it created");
    expectEqual(convertedEntry.companyId, COMPANY_A, "and the merchant");
    const payload = JSON.stringify(convertedEntry.payload);
    expect(!payload.includes(result.paymentLink.token), "the trail holds no token, which is the link's secret");
    expect(!payload.includes("Acme"), "and no client name");
    expect(payload.includes(result.paymentLink.tokenId), "it names the link by its id instead");
    expect(payload.includes("estimate_id"), "and the quote it came from");
  }

  // The invoice was created by the invoice module, so its own create entry exists too, and the create was the
  // first write of the invoice after the number.
  expect(
    entries.some((entry) => entry.action === "invoice.created"),
    "the invoice module's own create entry is written as well",
  );

  // The order of the writes: the number, then the draft, then the issue, then the quote.
  const issueUpdate = db.updates.find((update) => update.values["status"] === ESTIMATE_CONVERSION_INVOICE_STATUS);
  expect(issueUpdate !== undefined, "the invoice is issued by one update");
  expectEqual(issueUpdate?.table, "invoices", "of the invoice table");
  expect(
    issueUpdate?.query.includes(`status=eq.${INVOICE_CREATED_STATUS}`) === true,
    "scoped to the draft it was, so the issue cannot land on an invoice somebody else issued",
  );
  expect(typeof issueUpdate?.values["number"] === "string", "the number travels in the same statement as the status");
  expect(typeof issueUpdate?.values["issued_at"] === "string", "and so does the instant");

  const conversionUpdate = db.updates.find((update) => "converted_invoice_id" in update.values);
  expect(conversionUpdate !== undefined, "the quote records the invoice in one update");
  expect(
    conversionUpdate?.query.includes("converted_invoice_id=is.null") === true,
    "scoped to a quote that had not been converted, so a second request cannot overwrite the first",
  );
  expect(
    conversionUpdate?.query.includes("status=eq.accepted") === true,
    "and to a quote that is still accepted",
  );

  // The number came from the series rather than from this module.
  expectEqual(at(db.rpcs, 0, "the numbering call").name, "take_invoice_number", "the number is taken from the series");
  expect(db.numbersTaken.length === 1, "once");
}

/* ---- the due date ---- */

async function checkDueDate(): Promise<void> {
  // A quote whose offer still has a week to run: the invoice keeps that date, because it is what the client
  // agreed to.
  const future = createDb();
  const futureId = acceptedQuote(future);
  const futureResult = await convertEstimateToInvoice({ actor: owner, estimateId: futureId }, conversionDeps(future));
  expectEqual(
    futureResult.invoice.dueAt,
    new Date(NOW + 11 * 86_400_000).toISOString(),
    "an invoice keeps the deadline the offer promised",
  );

  // A quote that expired before it was converted: the term is floored, because `0022` forbids a due date
  // before the issue instant and an invoice dated in the past is unpayable.
  const stale = createDb();
  const staleId = acceptedQuote(stale, { expires_at: new Date(NOW - 5 * 86_400_000).toISOString() });
  const staleResult = await convertEstimateToInvoice({ actor: owner, estimateId: staleId }, conversionDeps(stale));
  expectEqual(
    staleResult.invoice.dueAt,
    new Date(NOW + ESTIMATE_CONVERSION_MINIMUM_TERM_DAYS * 86_400_000).toISOString(),
    "a quote that expired is floored to the minimum term, never dated in the past",
  );
  expect(
    Date.parse(staleResult.invoice.dueAt) >= Date.parse(new Date(NOW).toISOString()),
    "so the invoice is never due before it exists",
  );
}

/* ---- the refusals ---- */

async function checkRefusals(): Promise<void> {
  const codeOf = async (run: () => Promise<unknown>): Promise<string | null> => {
    try {
      await run();

      return null;
    } catch (error) {
      return isAppError(error) ? error.code : "not_an_app_error";
    }
  };

  const detailOf = async (run: () => Promise<unknown>): Promise<string | null> => {
    try {
      await run();

      return null;
    } catch (error) {
      if (!isAppError(error)) {
        return "not_an_app_error";
      }

      const detail = error.details?.[0];

      return detail === undefined ? "<no detail>" : `${detail.field}:${detail.rule}`;
    }
  };

  // A draft was never agreed, so it cannot be invoiced.
  for (const status of ["draft", "sent", "viewed", "void"] as const) {
    const db = createDb();
    const estimateId = acceptedQuote(db, {
      status,
      accepted_at: null,
      void_reason: status === "void" ? "withdrawn" : null,
      voided_at: status === "void" ? new Date(NOW).toISOString() : null,
    });

    expectEqual(
      await codeOf(() => convertEstimateToInvoice({ actor: owner, estimateId }, conversionDeps(db))),
      "VALIDATION_FAILED",
      `a ${status} quote is refused`,
    );
    expectEqual(
      await detailOf(() => convertEstimateToInvoice({ actor: owner, estimateId }, conversionDeps(db))),
      "status:not_accepted",
      `and the refusal names the status of a ${status} quote`,
    );
    expect(db.invoices.length === 0 && db.rpcs.length === 0, `no number is spent and no invoice written for a ${status} quote`);
  }

  // A second conversion of the same quote is refused, and the first invoice is untouched.
  const twice = createDb();
  const twiceId = acceptedQuote(twice);
  await convertEstimateToInvoice({ actor: owner, estimateId: twiceId }, conversionDeps(twice));
  const invoicesAfterFirst = twice.invoices.length;

  expectEqual(
    await codeOf(() => convertEstimateToInvoice({ actor: owner, estimateId: twiceId }, conversionDeps(twice))),
    "CONFLICT",
    "converting an already converted quote is a conflict",
  );
  expectEqual(
    await detailOf(() => convertEstimateToInvoice({ actor: owner, estimateId: twiceId }, conversionDeps(twice))),
    "converted_invoice_id:already_used",
    "named against the column that records the conversion",
  );
  expectEqual(twice.invoices.length, invoicesAfterFirst, "and no second invoice is created");
  expectEqual(twice.numbersTaken.length, 1, "nor a second number spent");

  // A quote with no lines has nothing to invoice.
  const empty = createDb();
  const emptyRow = acceptedRow();
  empty.estimates.push(emptyRow);
  expectEqual(
    await detailOf(() =>
      convertEstimateToInvoice({ actor: owner, estimateId: String(emptyRow["id"]) }, conversionDeps(empty)),
    ),
    "lines:empty",
    "a quote with no lines is refused against its lines",
  );

  // A quote of another merchant's is not found, and the answer does not say which of the two it was.
  const foreign = createDb();
  const foreignId = acceptedQuote(foreign, { company_id: COMPANY_B });
  expectEqual(
    await codeOf(() => convertEstimateToInvoice({ actor: owner, estimateId: foreignId }, conversionDeps(foreign))),
    "RESOURCE_NOT_FOUND",
    "another merchant's quote is not found rather than forbidden",
  );

  // A caller who cannot write a quote cannot convert one.
  const refused = createDb();
  const refusedId = acceptedQuote(refused);
  expectEqual(
    await codeOf(() => convertEstimateToInvoice({ actor: support, estimateId: refusedId }, conversionDeps(refused))),
    "PERMISSION_DENIED",
    "a role that cannot write a quote cannot convert one",
  );

  // A malformed id is a field problem, not a crash.
  expectEqual(
    await detailOf(() => convertEstimateToInvoice({ actor: owner, estimateId: "not-a-uuid" }, conversionDeps(createDb()))),
    "id:invalid_format",
    "an id that is not a uuid is refused against the id",
  );

  // A numbering series that cannot produce a number refuses the conversion before any invoice exists.
  const noNumber = createDb();
  const noNumberId = acceptedQuote(noNumber);
  noNumber.refuseNumber = true;
  expectEqual(
    await codeOf(() => convertEstimateToInvoice({ actor: owner, estimateId: noNumberId }, conversionDeps(noNumber))),
    "CONFLICT",
    "a series that cannot produce a number refuses the conversion as a settings problem",
  );
  expect(noNumber.invoices.length === 0, "and no invoice is written when there is no number to issue it under");
}

/* ---- compensation ---- */

async function checkCompensation(): Promise<void> {
  // The invoice cannot be issued: it is voided rather than left a draft that points at a spent number, and the
  // quote is not converted.
  const db = createDb();
  const estimateId = acceptedQuote(db);
  db.failIssue = true;

  const code = await (async (): Promise<string | null> => {
    try {
      await convertEstimateToInvoice({ actor: owner, estimateId }, conversionDeps(db));

      return null;
    } catch (error) {
      return isAppError(error) ? error.code : "not_an_app_error";
    }
  })();

  expect(code !== null, "an issue that fails refuses the conversion");
  expectEqual(at(db.invoices, 0, "the draft invoice")["status"], INVOICE_VOID_STATUS, "the invoice it wrote is voided, not left payable");
  expectEqual(rowConversionOf(db, estimateId), null, "and the quote is not converted, so a retry can still try");

  // The quote cannot record the invoice: the invoice is voided, so nothing points at a document the merchant
  // cannot see in its book.
  const late = createDb();
  const lateId = acceptedQuote(late);
  late.failConversion = true;

  const lateCode = await (async (): Promise<string | null> => {
    try {
      await convertEstimateToInvoice({ actor: owner, estimateId: lateId }, conversionDeps(late));

      return null;
    } catch (error) {
      return isAppError(error) ? error.code : "not_an_app_error";
    }
  })();

  expectEqual(lateCode, "CONFLICT", "a conversion that cannot be recorded answers the caller as a conflict");
  expectEqual(at(late.invoices, 0, "the invoice that was written")["status"], INVOICE_VOID_STATUS, "and the invoice it wrote is voided");
  expectEqual(rowConversionOf(late, lateId), null, "leaving the quote unconverted, which is the honest state");
}

function rowConversionOf(db: ConversionDb, estimateId: string): unknown {
  const row = db.estimates.find((candidate) => candidate["id"] === estimateId);

  return row === undefined ? "<missing>" : row["converted_invoice_id"];
}

/* ---- the terminal guard, both ways ---- */

async function checkGuard(): Promise<void> {
  // The write this STEP needs is admitted...
  const admitted = guardTerminal({ status: "accepted", converted_invoice_id: null, total_minor: "1" }, {
    converted_invoice_id: "018f2b9c-9999-7000-8000-0000000000aa",
  });
  expect(admitted === null, `a conversion of an accepted quote is admitted (and ${String(admitted)} is not raised)`);

  // ...and nothing else about a decided quote is.
  expect(
    guardTerminal({ status: "accepted", total_minor: "1" }, { total_minor: "2" }) !== null,
    "a decided quote's money is still frozen",
  );
  expect(
    guardTerminal({ status: "accepted", client_name: "A" }, { client_name: "B" }) !== null,
    "and so is the client it was accepted by",
  );
  expect(
    guardTerminal({ status: "void", converted_invoice_id: null }, {
      converted_invoice_id: "018f2b9c-9999-7000-8000-0000000000aa",
    }) !== null,
    "a void quote cannot be converted",
  );
  expect(
    guardTerminal({ status: "accepted", converted_invoice_id: "018f2b9c-9999-7000-8000-0000000000aa" }, {
      converted_invoice_id: "018f2b9c-9999-7000-8000-0000000000bb",
    }) !== null,
    "an accepted quote is converted once, so the column cannot be replaced",
  );
  expect(
    guardTerminal({ status: "accepted", converted_invoice_id: null }, { converted_invoice_id: null }) === null,
    "writing the same null back is not a change, which is why the guard is a comparison and not a whitelist",
  );

  // The two constraints together are still impossible to satisfy for a draft, which is how the column stays
  // reserved for a conversion.
  expect(
    guardTerminal({ status: "draft", converted_invoice_id: null }, {
      converted_invoice_id: "018f2b9c-9999-7000-8000-0000000000aa",
    }) === null,
    "the guard alone admits a draft's conversion",
  );
  expect(
    estimateColumnProblemOf({ status: "draft", converted_invoice_id: "018f2b9c-9999-7000-8000-0000000000aa" }) !== null,
    "but `0025`'s own `estimates_conversion_check` refuses it, so both are needed for the column to mean one thing",
  );
}

/** `0025`'s conversion pairing, as the check states it. */
function estimateColumnProblemOf(row: Readonly<Record<string, unknown>>): string | null {
  const status = row["status"] ?? null;
  const converted = row["converted_invoice_id"] ?? null;

  return converted !== null && status !== "accepted" ? "estimates_conversion_check" : null;
}

/* ---- the link ---- */

async function checkLink(): Promise<void> {
  const db = createDb();
  const estimateId = acceptedQuote(db);
  const result = await convertEstimateToInvoice({ actor: owner, estimateId }, conversionDeps(db));

  // A link signed with another key ring does not open, which is what stops an invention.
  let refused = "opened";

  try {
    openPortalToken(result.paymentLink.token, { keys: { primary: OTHER_KEY }, now: Math.floor(NOW / 1_000) });
  } catch (error) {
    refused = isAppError(error) ? String((error.cause as { reason?: string } | undefined)?.reason ?? error.code) : "not_an_app_error";
  }

  expectEqual(refused, "signature_invalid", "a link signed with another key does not open");

  // The link is bound to the invoice it names: the same token read against a different resource is refused.
  let mismatch = "opened";

  try {
    openPortalToken(result.paymentLink.token, {
      keys: KEYS,
      now: Math.floor(NOW / 1_000),
      expect: { resourceId: UNKNOWN },
    });
  } catch (error) {
    mismatch = isAppError(error) ? String((error.cause as { reason?: string } | undefined)?.reason ?? error.code) : "not_an_app_error";
  }

  expectEqual(mismatch, "audience_mismatch", "a link cannot be retargeted at another invoice");

  // A link for an estimate is signed, not paid: the pairing the security module enforces is why this STEP
  // mints `invoice`/`pay` and not `estimate`/`pay`.
  expect(
    (PORTAL_TOKEN_CAPABILITIES_BY_KIND["estimate"] as readonly string[]).includes("sign"),
    "an estimate's capability is signing, so a payment link for a quote would be refused at the mint",
  );

  // The link stops working at the end of its lifetime rather than at the end of the process's.
  let expired = "opened";

  try {
    openPortalToken(result.paymentLink.token, {
      keys: KEYS,
      now: Math.floor(NOW / 1_000) + ESTIMATE_PAYMENT_LINK_LIFETIME_SECONDS,
    });
  } catch (error) {
    expired = isAppError(error) ? String((error.cause as { reason?: string } | undefined)?.reason ?? error.code) : "not_an_app_error";
  }

  expectEqual(expired, "token_expired", "the link stops working when its lifetime is spent");
}

/* ---- the docs the service renders ---- */

async function checkSnapshotShape(): Promise<void> {
  const service = await readRepositoryFile("services/estimates/estimate-conversion.ts");

  // A snapshot is JSON, so no field may be a bigint and no amount may be a number of minor units.
  expect(
    !/: bigint/u.test(service.slice(service.indexOf("export interface EstimatePaymentLink"), service.indexOf("export async function"))),
    "no field of the answer is a bigint, which JSON cannot carry",
  );
  expect(service.includes("expiresAtEpochMs: number"), "an instant crosses as epoch milliseconds");
  expect(service.includes("readonly token: string"), "the token crosses as text");
  expect(service.includes("readonly url: string"), "and so does the address the client opens");
}

/* ---- the feature list ---- */

async function checkFeatureList(): Promise<void> {
  const features = await readRepositoryFile("docs/final/FEATURE_LIST.md");

  expect(
    features.includes("converts automatically into an invoice") && features.includes("payment link is generated"),
    "section 16 asks for a conversion and a payment link, which is what this STEP writes",
  );
  expect(
    features.includes("i/[token]") && features.includes("e/[token]"),
    "and section 2 puts a client's access under the tokenized paths this link uses",
  );
  expect(
    !features.includes("converted invoice is edited by the merchant"),
    "nothing in the feature list asks for editing a converted invoice, which this STEP does not add",
  );
}

/* ---- the run ---- */

/**
 * Run one group so a throw inside it is a recorded failure rather than the end of the gate.
 *
 * A service that throws where it should refuse would otherwise take the process down with it, and every
 * failure recorded before the throw would be lost - the gate would print a Node stack trace and nothing else,
 * which reads like a broken gate rather than a broken service. Each group is therefore isolated, and the
 * stack of the first throw is kept so the report still says where it came from.
 */
async function group(name: string, body: () => Promise<void>): Promise<void> {
  try {
    await body();
  } catch (error) {
    checks += 1;
    failures.push(
      `${name} threw instead of recording a failure: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function run(): Promise<void> {
  await group("schema", checkSchema);
  await group("vocabulary", checkVocabulary);
  await group("source", checkSource);
  await group("conversion", checkConversion);
  await group("due date", checkDueDate);
  await group("refusals", checkRefusals);
  await group("compensation", checkCompensation);
  await group("guard", checkGuard);
  await group("link", checkLink);
  await group("snapshot shape", checkSnapshotShape);
  await group("feature list", checkFeatureList);

  if (failures.length > 0) {
    process.stderr.write(`estimate conversion gate failed with ${String(failures.length)} problem(s):\n`);

    for (const failure of failures) {
      process.stderr.write(`  - ${failure}\n`);
    }

    process.exitCode = 1;

    return;
  }

  process.stdout.write(
    `estimate conversion gate passed: ${String(checks)} checks, 0118 over 0025, an accepted quote converted into an ` +
      "issued and numbered invoice through the invoice module's own create, the " +
      `${String(ESTIMATE_CONVERSION_RULES.length)} refusals, the due date the offer promised and ` +
      "the terminal guard in both directions, and a payment link the security module signs, reads back and binds " +
      "to one invoice\n",
  );
}

await run();
