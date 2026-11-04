// path: services/invoices/verify.ts
import process from "node:process";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { z } from "zod";
import { createInMemoryAuditTrail, type AuditTrail } from "../../lib/auth/audit.ts";
import type { RestClient } from "../../lib/auth/rest.ts";
import type { PlatformRole, RequestActor } from "../../lib/auth/types.ts";
import { AppError, isAppError } from "../../lib/errors/app-error.ts";
import {
  INVOICE_ABANDONED_AUDIT_ACTION,
  INVOICE_CLIENT_OPTION_LIMIT,
  INVOICE_CREATED_AUDIT_ACTION,
  INVOICE_MANAGE_ROLES,
  INVOICE_RULES,
  createInvoice,
  getInvoice,
  invoiceItemRowSchema,
  invoiceRowSchema,
  listInvoiceCatalogueOptions,
  listInvoiceClientOptions,
  type InvoiceDependencies,
} from "./invoices.ts";
import {
  INVOICE_LINE_ADDED_AUDIT_ACTION,
  INVOICE_LINE_REMOVED_AUDIT_ACTION,
  INVOICE_LINE_UPDATED_AUDIT_ACTION,
  addInvoiceLine,
  invoiceLineRowSchema,
  removeInvoiceLine,
  updateInvoiceLine,
  type InvoiceLineDependencies,
} from "./invoice-lines.ts";
import {
  INVOICE_LINE_MOVED_AUDIT_ACTION,
  moveInvoiceLine,
} from "./invoice-line-order.ts";
import { parseInvoiceLine, type ParsedLine } from "./invoices.ts";
import {
  INVOICE_CREATED_STATUS,
  INVOICE_DEFAULT_UNIT,
  INVOICE_ITEM_DESCRIPTION_LIMITS,
  INVOICE_MAXIMUM_LINES,
  INVOICE_QUANTITY_MAXIMUM,
  INVOICE_QUANTITY_MINIMUM,
  INVOICE_UNITS,
} from "./invoice-fields.ts";
import {
  invoiceTotalsOf,
  lineTotalMinor,
  quantityToThousandths,
  subtotalOf,
  thousandthsToQuantity,
} from "./invoice-totals.ts";
import { priceFromMinor, priceToMinor } from "../products/price.ts";

/**
 * Invoice gate for STEP 112. Run with `node services/invoices/verify.ts`.
 *
 * The gate drives the real service over an in-memory PostgREST of `0022` and `0023`, so what passes here
 * is the code the route runs:
 *
 *   1. the arithmetic: the generated column's rule - `(quantity * unit_price_minor)::bigint - discount` -
 *      reproduced in integers with PostgreSQL's half-away-from-zero rounding, proved equal to the
 *      database's own expression on the cases that separate rounding from truncation;
 *   2. the money: every typed amount becomes whole minor units by decimal string arithmetic, with no
 *      float anywhere on the path;
 *   3. the validation: each ceiling the migration states, every field named at once as
 *      `lines[2].unit_price`, and the invoice-level discount bounded by what the lines add up to;
 *   4. the tenancy: the company comes from the session, the client is read from the merchant's own book
 *      through `getClient`, a foreign or unknown client is the same 404, and only the owner may write;
 *   5. the draft: a create writes `draft` with no number and no issue instant, which is the shape
 *      `invoices_issue_check` requires of a draft;
 *   6. the compensation: a lines insert that fails removes the invoice it wrote, and says so in the trail;
 *   7. the audit: `invoice.created` names the row, the company and the actor, and never the client's
 *      name, the memo or a line's description;
 *   8. the sources: the routes are token-checked and on the protected list, the columns the code names
 *      are the ones the migrations created, and the catalog carries every key the screens use.
 */

const repositoryRoot = new URL("../../", import.meta.url);

const failures: string[] = [];
let checks = 0;

function expect(condition: boolean, description: string): void {
  checks += 1;

  if (!condition) {
    failures.push(description);
  }
}

function printable(value: unknown): string {
  return typeof value === "bigint" ? `${value.toString()}n` : JSON.stringify(value);
}

function expectEqual<T>(actual: T, expected: T, description: string): void {
  checks += 1;

  if (actual !== expected) {
    failures.push(`${description} (expected ${printable(expected)}, received ${printable(actual)})`);
  }
}

function expectDeepEqual(actual: unknown, expected: unknown, description: string): void {
  checks += 1;

  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);

  if (left !== right) {
    failures.push(`${description} (expected ${right}, received ${left})`);
  }
}

async function readRepositoryFile(repositoryPath: string): Promise<string> {
  return readFile(new URL(repositoryPath, repositoryRoot), "utf8");
}

function at<T>(items: readonly T[], index: number, description: string): T {
  const item = items[index];

  if (item === undefined) {
    throw new Error(`gate fixture: ${description} is missing at index ${index}`);
  }

  return item;
}

const NOW = Date.parse("2026-11-04T09:00:00.000Z");

const OWNER_ID = "018f2b8a-1111-4c2d-9c3e-000000000001";
const OTHER_OWNER_ID = "018f2b8a-1111-4c2d-9c3e-000000000002";
const OFFICE_ID = "018f2b8a-1111-4c2d-9c3e-000000000003";

const COMPANY_A = "018f2b8a-4444-4c2d-9c3e-000000000001";
const COMPANY_B = "018f2b8a-4444-4c2d-9c3e-000000000002";

const CLIENT_A = "018f2b8a-5555-4c2d-9c3e-000000000001";
const CLIENT_B = "018f2b8a-5555-4c2d-9c3e-000000000002";

const PRODUCT_A = "018f2b8a-6666-4c2d-9c3e-000000000001";
const SERVICE_A = "018f2b8a-6666-4c2d-9c3e-000000000002";

function actorOf(
  roles: readonly PlatformRole[],
  companyId: string | null,
  overrides: Partial<RequestActor> = {},
): RequestActor {
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
    mfaVerifiedAtEpochMs: NOW,
    reauthenticatedAtEpochMs: NOW,
    ...overrides,
  };
}

const owner = actorOf(["owner"], COMPANY_A);
const otherOwner = actorOf(["owner"], COMPANY_B, { userId: OTHER_OWNER_ID });
const desk = actorOf(["compliance_kyc"], null, { userId: OFFICE_ID });

/* ---- an in-memory invoices, invoice_items and clients shaped like 0022, 0023 and 0019 ---- */

interface InvoiceDb {
  readonly clients: Array<Record<string, unknown>>;
  readonly products: Array<Record<string, unknown>>;
  readonly services: Array<Record<string, unknown>>;
  readonly invoices: Array<Record<string, unknown>>;
  readonly items: Array<Record<string, unknown>>;
  /** Set to make the lines insert fail, which is how the compensation path is reached. */
  failItems: boolean;
  inserts: Array<{ readonly table: string; readonly rows: readonly Readonly<Record<string, unknown>>[] }>;
  updates: Array<{ readonly table: string; readonly query: string; readonly values: Record<string, unknown> }>;
  /** Set while a test wants every intermediate position write checked against the unique index. */
  strictPositions: boolean;
  queries: string[];
}

function clientRow(input: {
  readonly id: string;
  readonly companyId: string;
  readonly name: string;
  readonly email?: string | null;
  readonly city?: string | null;
}): Record<string, unknown> {
  return {
    id: input.id,
    company_id: input.companyId,
    name: input.name,
    company_name: null,
    email: input.email ?? null,
    phone: null,
    address_line1: input.city === undefined ? null : "12 Market Street",
    address_line2: null,
    city: input.city ?? null,
    region: null,
    postal_code: null,
    country: "US",
    tax_id: null,
    notes: null,
    created_at: new Date(NOW).toISOString(),
    updated_at: new Date(NOW).toISOString(),
    deleted_at: null,
    version: 1,
  };
}

function createDb(): InvoiceDb {
  return {
    clients: [
      clientRow({ id: CLIENT_A, companyId: COMPANY_A, name: "Acme Ltd", email: "billing@acme.example", city: "Austin" }),
      clientRow({ id: CLIENT_B, companyId: COMPANY_B, name: "Other Co" }),
    ],
    products: [
      {
        id: PRODUCT_A,
        company_id: COMPANY_A,
        name: "Desk lamp",
        sku: "LAMP-01",
        code: null,
        description: null,
        unit_price_minor: "425000",
        currency: "USD",
        unit: "item",
        created_at: new Date(NOW).toISOString(),
        updated_at: new Date(NOW).toISOString(),
        deleted_at: null,
        version: 1,
      },
    ],
    services: [
      {
        id: SERVICE_A,
        company_id: COMPANY_A,
        name: "Consulting",
        sku: null,
        code: "CONSULT",
        description: null,
        unit_price_minor: "1250000",
        currency: "USD",
        unit: "hour",
        created_at: new Date(NOW).toISOString(),
        updated_at: new Date(NOW).toISOString(),
        deleted_at: null,
        version: 1,
      },
    ],
    invoices: [],
    items: [],
    failItems: false,
    strictPositions: false,
    inserts: [],
    updates: [],
    queries: [],
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

/** PostgREST answers a `bigint` as a number or a decimal string, never as a bigint; the fixture agrees. */
function wireOf(row: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const wire: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(row)) {
    wire[key] = typeof value === "bigint" ? value.toString() : value;
  }

  return wire;
}

/**
 * `invoice_items_sync_totals`, and `invoices_derive_total` after it.
 *
 * The trigger recomputes the parent's subtotal from the live lines on every row change and then the
 * invoice's own trigger derives the total. The fixture performs both, because every line write in this
 * service relies on them and none of them sends a total.
 */
function syncSubtotal(db: InvoiceDb, invoiceId: string): void {
  const parent = db.invoices.find((row) => row["id"] === invoiceId);

  if (parent === undefined) {
    return;
  }

  const subtotal = db.items
    .filter((row) => row["invoice_id"] === invoiceId && row["deleted_at"] === null)
    .reduce((total, row) => total + BigInt(String(row["line_total_minor"])), 0n);

  parent["subtotal_minor"] = subtotal.toString();
  parent["total_minor"] = (
    subtotal - BigInt(String(parent["discount_minor"])) + BigInt(String(parent["tax_minor"]))
  ).toString();
}

/**
 * `(quantity * unit_price_minor)::bigint`, as PostgreSQL computes it.
 *
 * The fixture does not call the module's own function for this, because an assertion that asked the
 * code under test what the answer was would prove nothing. The quantity arrives as the decimal text the
 * service sent, is turned into an exact `BigInt` numerator over 1000, and the cast is modelled as the
 * database performs it: round half away from zero. This is the independent side of the arithmetic
 * comparison below.
 */
function databaseLineTotal(quantity: string, unitPriceMinor: bigint, discountMinor: bigint): bigint {
  const [whole = "0", fraction = ""] = quantity.split(".");
  const thousandths = BigInt(whole) * 1_000n + BigInt(fraction.padEnd(3, "0"));
  const product = thousandths * unitPriceMinor;
  const magnitude = product < 0n ? -product : product;
  const rounded = (magnitude + 500n) / 1_000n;

  return (product < 0n ? -rounded : rounded) - discountMinor;
}

/** The tables this gate models, so a service that touched a fourth would be caught rather than guessed. */
const MODELLED_TABLES = ["clients", "products", "services", "invoices", "invoice_items"] as const;

function rowsOf(db: InvoiceDb, table: string): Array<Record<string, unknown>> {
  switch (table) {
    case "clients":
      return db.clients;
    case "products":
      return db.products;
    case "services":
      return db.services;
    case "invoices":
      return db.invoices;
    case "invoice_items":
      return db.items;
    default:
      throw new Error(`the invoice service touches no table the gate does not model: ${table}`);
  }
}

function createInvoiceRest(db: InvoiceDb): RestClient {
  return {
    select<TRow>(table: string, query: string, schema: z.ZodType<TRow>): Promise<readonly TRow[]> {
      db.queries.push(`${table}?${query}`);

      if (!(MODELLED_TABLES as readonly string[]).includes(table)) {
        return Promise.reject(new Error(`an unmodelled table was read: ${table}`));
      }

      const parts = queryParts(query);
      const company = parts.get("company_id");

      if (company === undefined || !company.startsWith("eq.")) {
        return Promise.reject(new Error(`a read is not scoped to one company: ${query}`));
      }

      const companyId = company.slice(3);
      let matched = rowsOf(db, table).filter((row) => row["company_id"] === companyId);

      for (const [key, value] of parts) {
        if (key === "select" || key === "order" || key === "limit" || key === "offset" || key === "or") {
          continue;
        }

        if (value === "is.null") {
          matched = matched.filter((row) => row[key] === null);
        } else if (value.startsWith("eq.")) {
          matched = matched.filter((row) => row[key] === value.slice(3));
        }
      }

      const order = parts.get("order");

      if (order !== undefined) {
        const [column = "", direction = "asc"] = order.split(",")[0]?.split(".") ?? [];

        matched = [...matched].sort((left, right) => {
          const a = String(left[column] ?? "");
          const b = String(right[column] ?? "");
          const comparison = a < b ? -1 : a > b ? 1 : 0;

          return direction === "desc" ? -comparison : comparison;
        });
      }

      const limit = parts.get("limit");

      if (limit !== undefined) {
        matched = matched.slice(0, Number.parseInt(limit, 10));
      }

      const selection = parts.get("select");
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

      return Promise.resolve(projected.map((row) => schema.parse(row)));
    },
    insert(table: string, rows: readonly Readonly<Record<string, unknown>>[]): Promise<void> {
      db.inserts.push({ table, rows });

      if (table !== "invoice_items") {
        return Promise.reject(new Error(`the invoice service inserts lines by themselves: ${table}`));
      }

      if (db.failItems) {
        // `invoice_items_guard_catalogue` raises a check_violation, which the REST layer reports as
        // VALIDATION_FAILED. The fixture does the same rather than inventing a different code.
        return Promise.reject(new AppError("VALIDATION_FAILED"));
      }

      const invoiceId = String(rows[0]?.["invoice_id"] ?? "");
      const parent = db.invoices.find((row) => row["id"] === invoiceId);

      if (parent === undefined) {
        return Promise.reject(new AppError("VALIDATION_FAILED"));
      }

      for (const row of rows) {
        const unitPriceMinor = BigInt(String(row["unit_price_minor"]));
        const discountMinor = BigInt(String(row["discount_minor"] ?? "0"));
        const lineTotal = databaseLineTotal(String(row["quantity"]), unitPriceMinor, discountMinor);

        // `invoice_items_discount_check`: the discount never exceeds the rounded gross.
        if (discountMinor > lineTotal + discountMinor) {
          return Promise.reject(new AppError("VALIDATION_FAILED"));
        }

        // `invoice_items_guard_catalogue`: a product or a service from another merchant cannot be billed.
        for (const column of ["product_id", "service_id"] as const) {
          const reference = row[column];

          if (typeof reference === "string") {
            const catalogue = column === "product_id" ? db.products : db.services;
            const found = catalogue.some(
              (entry) => entry["id"] === reference && entry["company_id"] === row["company_id"],
            );

            if (!found) {
              return Promise.reject(new AppError("VALIDATION_FAILED"));
            }
          }
        }

        db.items.push({
          id: randomUUID(),
          deleted_at: null,
          version: 1,
          created_at: new Date(NOW).toISOString(),
          updated_at: new Date(NOW).toISOString(),
          line_total_minor: lineTotal.toString(),
          ...wireOf(row),
        });
      }

      // `invoice_items_sync_totals` sums the live lines into the parent, and `invoices_derive_total`
      // turns that into the total. The fixture performs both, because the service relies on them.
      const subtotal = db.items
        .filter((row) => row["invoice_id"] === invoiceId && row["deleted_at"] === null)
        .reduce((total, row) => total + BigInt(String(row["line_total_minor"])), 0n);

      parent["subtotal_minor"] = subtotal.toString();
      parent["total_minor"] = (
        subtotal -
        BigInt(String(parent["discount_minor"])) +
        BigInt(String(parent["tax_minor"]))
      ).toString();

      return Promise.resolve();
    },
    insertReturning<TRow>(
      table: string,
      rows: readonly Readonly<Record<string, unknown>>[],
      schema: z.ZodType<TRow>,
    ): Promise<readonly TRow[]> {
      db.inserts.push({ table, rows });

      if (table === "invoice_items") {
        // The editor adds one line per request and reads it back for its generated total.
        const row = rows[0];

        if (rows.length !== 1 || row === undefined) {
          return Promise.reject(new Error("a line is added one at a time"));
        }

        const parent = db.invoices.find((candidate) => candidate["id"] === row["invoice_id"]);

        if (parent === undefined || parent["company_id"] !== row["company_id"]) {
          return Promise.reject(new AppError("VALIDATION_FAILED"));
        }

        // The draft lock, as `invoice_items_sync_totals` states it.
        if (parent["status"] !== "draft") {
          return Promise.reject(new AppError("CONFLICT"));
        }

        const unitPriceMinor = BigInt(String(row["unit_price_minor"]));
        const discountMinor = BigInt(String(row["discount_minor"] ?? "0"));
        const lineTotal = databaseLineTotal(String(row["quantity"]), unitPriceMinor, discountMinor);
        const position = Number(row["position"]);

        // `invoice_items_position_key` and `invoice_items_position_check`.
        if (position < 1 || db.items.some((existing) => existing["invoice_id"] === row["invoice_id"] && existing["deleted_at"] === null && existing["position"] === position)) {
          return Promise.reject(new AppError("CONFLICT"));
        }

        for (const column of ["product_id", "service_id"] as const) {
          const reference = row[column];

          if (typeof reference === "string") {
            const catalogue = column === "product_id" ? db.products : db.services;

            if (!catalogue.some((entry) => entry["id"] === reference && entry["company_id"] === row["company_id"])) {
              return Promise.reject(new AppError("VALIDATION_FAILED"));
            }
          }
        }

        const stored: Record<string, unknown> = {
          id: randomUUID(),
          deleted_at: null,
          version: 1,
          created_at: new Date(NOW + db.items.length).toISOString(),
          updated_at: new Date(NOW + db.items.length).toISOString(),
          line_total_minor: lineTotal.toString(),
          ...wireOf(row),
        };

        db.items.push(stored);
        syncSubtotal(db, String(row["invoice_id"]));

        return Promise.resolve([schema.parse(stored)]);
      }

      if (table !== "invoices") {
        return Promise.reject(new Error(`return=representation is used for invoices and lines only: ${table}`));
      }

      for (const row of rows) {
        // `invoices_derive_total` owns the total; the fixture derives it so a service that sent its own
        // would be caught by the assertion that no money column is written here.
        const stored: Record<string, unknown> = {
          id: randomUUID(),
          number: null,
          status: "draft",
          subtotal_minor: "0",
          discount_minor: "0",
          tax_minor: "0",
          amount_paid_minor: "0",
          issued_at: null,
          first_viewed_at: null,
          paid_at: null,
          voided_at: null,
          deleted_at: null,
          version: 1,
          created_at: new Date(NOW + db.invoices.length).toISOString(),
          updated_at: new Date(NOW + db.invoices.length).toISOString(),
          client_email: null,
          client_address: null,
          memo: null,
          ...wireOf(row),
        };

        // `invoices_derive_total`, before the row is read back: total = subtotal - discount + tax.
        stored["total_minor"] = (
          BigInt(String(stored["subtotal_minor"])) -
          BigInt(String(stored["discount_minor"])) +
          BigInt(String(stored["tax_minor"]))
        ).toString();

        // `invoices_status_money_check` and `invoices_issue_check`, as the migration states them.
        if (stored["status"] === "draft" && (stored["number"] !== null || stored["issued_at"] !== null)) {
          return Promise.reject(new AppError("VALIDATION_FAILED"));
        }

        // `invoices_discount_check`, enforced on the insert exactly as the database enforces it: the
        // discount may never exceed the subtotal, and a row being inserted has no lines yet, so its
        // subtotal is the column default of zero. An insert carrying any discount is refused here - which
        // is why the service applies the invoice-level discount in a second write.
        if (BigInt(String(stored["discount_minor"])) > BigInt(String(stored["subtotal_minor"]))) {
          return Promise.reject(new AppError("VALIDATION_FAILED"));
        }

        if (BigInt(String(stored["total_minor"])) < 0n) {
          return Promise.reject(new AppError("VALIDATION_FAILED"));
        }

        db.invoices.push(stored);

        return Promise.resolve([schema.parse(stored)]);
      }

      return Promise.reject(new Error("insertReturning needs one row"));
    },
    update(table: string, query: string, values: Readonly<Record<string, unknown>>): Promise<void> {
      db.updates.push({ table, query, values: { ...values } });

      if (table === "invoice_items") {
        const parts = queryParts(query);
        const id = parts.get("id");
        const company = parts.get("company_id");
        const invoice = parts.get("invoice_id");
        const liveOnly = parts.get("deleted_at") === "is.null";

        if (id === undefined || company === undefined) {
          return Promise.reject(new Error(`a line update is not scoped to one row of one company: ${query}`));
        }

        const row = db.items.find(
          (candidate) =>
            candidate["id"] === id.slice(3) &&
            candidate["company_id"] === company.slice(3) &&
            (invoice === undefined || candidate["invoice_id"] === invoice.slice(3)) &&
            (!liveOnly || candidate["deleted_at"] === null),
        );

        if (row === undefined) {
          return Promise.resolve();
        }

        const parent = db.invoices.find((candidate) => candidate["id"] === row["invoice_id"]);

        // The draft lock, as the trigger states it: a line of an issued invoice cannot move.
        if (parent !== undefined && parent["status"] !== "draft") {
          return Promise.reject(new AppError("CONFLICT"));
        }

        // The unique index, over the live rows of one invoice, checked on **every** statement because
        // `invoice_items_position_key` is not deferrable. `strictPositions` makes the gate assert that no
        // intermediate write of a swap ever leaves two live rows holding one position.
        const nextPosition = values["position"];

        if (typeof nextPosition === "number") {
          if (nextPosition < 1) {
            return Promise.reject(new AppError("VALIDATION_FAILED"));
          }

          const clash = db.items.some(
            (candidate) =>
              candidate !== row &&
              candidate["invoice_id"] === row["invoice_id"] &&
              candidate["deleted_at"] === null &&
              candidate["position"] === nextPosition,
          );

          if (clash) {
            return Promise.reject(new AppError("CONFLICT"));
          }
        }

        if (db.strictPositions) {
          // The whole table, after the write: a live row's position must be unique within its invoice.
          const seen = new Map<string, number>();

          for (const candidate of [...db.items.filter((entry) => entry !== row), { ...row, ...wireOf(values) }]) {
            if (candidate["deleted_at"] !== null) {
              continue;
            }

            const key = `${String(candidate["invoice_id"])}:${String(candidate["position"])}`;

            seen.set(key, (seen.get(key) ?? 0) + 1);
          }

          for (const [key, count] of seen) {
            if (count > 1) {
              return Promise.reject(new Error(`invoice_items_position_key would be violated after this write: ${key}`));
            }
          }
        }

        const merged: Record<string, unknown> = { ...row, ...wireOf(values) };

        if (values["quantity"] !== undefined || values["unit_price_minor"] !== undefined || values["discount_minor"] !== undefined) {
          merged["line_total_minor"] = databaseLineTotal(
            String(merged["quantity"]),
            BigInt(String(merged["unit_price_minor"])),
            BigInt(String(merged["discount_minor"] ?? "0")),
          ).toString();
        }

        Object.assign(row, merged, {
          updated_at: new Date(NOW + 20_000).toISOString(),
          version: Number(row["version"]) + 1,
        });
        syncSubtotal(db, String(row["invoice_id"]));

        return Promise.resolve();
      }

      if (table !== "invoices") {
        return Promise.reject(new Error(`the invoice service updates no other table: ${table}`));
      }

      const parts = queryParts(query);
      const id = parts.get("id");
      const company = parts.get("company_id");
      const status = parts.get("status");

      if (id === undefined || company === undefined) {
        return Promise.reject(new Error(`an invoice update is not scoped to one row of one company: ${query}`));
      }

      const row = db.invoices.find(
        (candidate) => candidate["id"] === id.slice(3) && candidate["company_id"] === company.slice(3),
      );

      if (row === undefined || (status !== undefined && row["status"] !== status.slice(3))) {
        return Promise.resolve();
      }

      const next: Record<string, unknown> = { ...row, ...wireOf(values) };
      const subtotal = BigInt(String(next["subtotal_minor"]));
      const discount = BigInt(String(next["discount_minor"]));
      const tax = BigInt(String(next["tax_minor"]));

      // `invoices_discount_check`, `invoices_tax_check` and `invoices_total_check`, on the values the row
      // will hold after the update. `invoices_derive_total` runs before the check, as the trigger does.
      if (discount < 0n || discount > subtotal) {
        return Promise.reject(new AppError("VALIDATION_FAILED"));
      }

      if (tax < 0n || subtotal - discount + tax < 0n) {
        return Promise.reject(new AppError("VALIDATION_FAILED"));
      }

      Object.assign(row, wireOf(values), {
        total_minor: (subtotal - discount + tax).toString(),
        updated_at: new Date(NOW + 10_000).toISOString(),
        version: Number(row["version"]) + 1,
      });

      return Promise.resolve();
    },
    rpc(): Promise<never> {
      return Promise.reject(new Error("the invoice service calls no rpc"));
    },
  };
}

function depsOf(db: InvoiceDb, audit: AuditTrail = createInMemoryAuditTrail()): InvoiceDependencies {
  return { rest: createInvoiceRest(db), audit, now: () => NOW };
}

/** The same fixture, for the line editor's narrower dependency type. */
function lineDepsOf(db: InvoiceDb, audit: AuditTrail = createInMemoryAuditTrail()): InvoiceLineDependencies {
  return { rest: createInvoiceRest(db), audit, now: () => NOW };
}

/** The live lines of an invoice, read straight from the fixture, for assertions about the stored order. */
async function readLiveLinesForTest(db: InvoiceDb, invoiceId: string) {
  return createInvoiceRest(db).select(
    "invoice_items",
    `select=id,company_id,invoice_id,position,description,unit,quantity,unit_price_minor,discount_minor,line_total_minor,product_id,service_id,created_at,updated_at,deleted_at,version&invoice_id=eq.${invoiceId}&company_id=eq.${at(db.invoices, 0, "the invoice")["company_id"] as string}&deleted_at=is.null&order=position.asc`,
    invoiceLineRowSchema,
  );
}

/** The error code a line write answered with, or null when it succeeded. */
async function lineCodeOf(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run();

    return null;
  } catch (error) {
    return isAppError(error) ? error.code : "not-an-app-error";
  }
}

/** A body with one good line, which every case below starts from and perturbs. */
function bodyOf(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    client_id: CLIENT_A,
    currency: "USD",
    due_at: new Date(NOW + 20 * 86_400_000).toISOString(),
    memo: "",
    discount: "",
    tax: "",
    lines: [
      {
        description: "Consulting",
        unit: "hour",
        quantity: "2.5",
        unit_price: "125.00",
        discount: "",
      },
    ],
    ...overrides,
  };
}

/** The details of a validation refusal, or an empty list when the call did not refuse that way. */
async function refusalOf(run: () => Promise<unknown>): Promise<readonly { readonly field?: unknown; readonly rule?: unknown }[]> {
  try {
    await run();

    return [];
  } catch (error) {
    if (isAppError(error) && error.code === "VALIDATION_FAILED") {
      return error.details;
    }

    return [];
  }
}

/** The error code a call answered with, or null when it succeeded. */
async function codeOf(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run();

    return null;
  } catch (error) {
    return isAppError(error) ? error.code : "not-an-app-error";
  }
}

/* ---- 1. the arithmetic ---- */

function checkArithmetic(): void {
  // The cases that separate rounding from truncation, and the ones a real invoice is made of.
  //
  // Every quantity here respects the column's scale of three. A rounding case needs a price whose minor
  // unit count is not a multiple of 1000, so a thousandth of a unit lands between two minor units:
  // `0.0001` is one minor unit, and a quantity of 0.5 of one is exactly half of it.
  const cases: readonly (readonly [string, string, string, string])[] = [
    // quantity, price, expected line total, why
    ["1", "125.0000", "1250000", "one whole unit of 125 is exactly 125000 minor units"],
    ["2.5", "125.0000", "3125000", "two and a half hours at 125 is 312.50"],
    ["0.001", "1000.0000", "10000", "a thousandth of a thousand dollars is one dollar"],
    ["2.5", "400.0000", "10000000", "two and a half of four hundred is a thousand dollars"],
    ["999999.999", "1.0000", "9999999990", "a large quantity stays exact"],
    // Half away from zero, which is how PostgreSQL casts a numeric to bigint.
    ["0.5", "0.0001", "1", "exactly half a minor unit rounds away from zero"],
    ["1.5", "0.0001", "2", "one and a half minor units rounds to two"],
    ["2.5", "0.0001", "3", "two and a half rounds to three, not to the even two"],
    ["0.502", "0.0001", "1", "just over half rounds up"],
    ["0.498", "0.0001", "0", "just under half rounds down"],
    ["0.001", "0.0001", "0", "a thousandth of a minor unit is not a minor unit"],
    ["999.999", "0.0001", "1000", "and a long fraction still rounds to a whole minor unit"],
  ];

  for (const [quantity, price, expected, why] of cases) {
    const thousandths = quantityToThousandths(quantity);
    const minor = priceToMinor(price);

    expect(thousandths !== null && minor !== null, `the fixture parses the quantity ${quantity} and the price ${price}`);

    if (thousandths === null || minor === null) {
      continue;
    }

    const total = lineTotalMinor({ quantityThousandths: thousandths, unitPriceMinor: minor, discountMinor: 0n });
    const database = databaseLineTotal(quantity, minor, 0n);

    expectEqual(total, BigInt(expected), `the engine totals ${quantity} at ${price}: ${why}`);
    expectEqual(total, database, `and agrees with the database's own cast for ${quantity} at ${price}`);
  }

  // A discount is subtracted after the rounding, which is what the generated column states.
  const discounted = lineTotalMinor({
    quantityThousandths: quantityToThousandths("2.5") ?? 0n,
    unitPriceMinor: priceToMinor("125.00") ?? 0n,
    discountMinor: priceToMinor("25.00") ?? 0n,
  });

  expectEqual(discounted, 2_875_000n, "a line discount comes off the rounded gross");
  expectEqual(
    discounted,
    databaseLineTotal("2.5", 1_250_000n, 250_000n),
    "and matches the database's generated column",
  );

  // The subtotal is the sum of the live lines, and `coalesce(sum(...), 0)` is what an empty one means.
  expectEqual(subtotalOf([]), 0n, "no lines is a subtotal of zero");
  expectEqual(
    subtotalOf([
      { quantityThousandths: 2_500n, unitPriceMinor: 1_250_000n, discountMinor: 0n },
      { quantityThousandths: 1_000n, unitPriceMinor: 42_500n, discountMinor: 0n },
    ]),
    3_167_500n,
    "two lines add up",
  );

  // `invoices_derive_total`, verbatim.
  const totals = invoiceTotalsOf({ subtotalMinor: 3_167_500n, discountMinor: 100_000n, taxMinor: 50_000n });

  expectEqual(totals.totalMinor, 3_117_500n, "the invoice total is subtotal - discount + tax");

  // The quantity round trip: what a merchant types is what the form prints back.
  for (const [typed, expected] of [
    ["1", "1"],
    ["2.5", "2.5"],
    ["0.001", "0.001"],
    ["2.050", "2.05"],
    ["1000000", "1000000"],
  ] as const) {
    const thousandths = quantityToThousandths(typed);
    const printed = thousandths === null ? null : thousandthsToQuantity(thousandths);

    expectEqual(printed, expected, `a quantity of ${typed} prints back as ${expected}`);
  }

  // A quantity the column's scale cannot hold is refused rather than rounded by the database.
  for (const refused of ["1.2345", "-1", "abc", "1,000", "10000000", ""]) {
    expectEqual(quantityToThousandths(refused), null, `the quantity ${JSON.stringify(refused)} is not a quantity`);
  }
}

/* ---- 2 and 3. the validation ---- */

async function checkValidation(): Promise<void> {
  // A good body creates a draft with the client's snapshot and the database's totals.
  const db = createDb();
  const invoice = await createInvoice({ actor: owner, body: bodyOf() }, depsOf(db));

  expectEqual(invoice.status, "draft", "a create writes a draft");
  expectEqual(invoice.client.name, "Acme Ltd", "the printed name comes from the client book");
  expectEqual(invoice.client.email, "billing@acme.example", "and so does the address the invoice prints");
  expect(invoice.client.address !== null && invoice.client.address.includes("Austin"), "the client's city is on the address");
  expectEqual(invoice.totals.subtotalMinor, "3125000", "the subtotal is the trigger's sum of the lines");
  expectEqual(invoice.totals.totalMinor, "3125000", "and the total is subtotal - discount + tax");
  expectEqual(invoice.totals.total, "312.5000", "printed at the scale the column stores");
  expectEqual(invoice.lines.length, 1, "one line was written");
  expectEqual(at(invoice.lines, 0, "the line").quantity, "2.5", "the typed quantity prints back");
  expectEqual(at(invoice.lines, 0, "the line").lineTotalMinor, "3125000", "and the line amount");

  // The snapshot crosses JSON. A `bigint` throws in `JSON.stringify`, so this is the assertion that a
  // successful create can actually be answered - the failure the stub-free runtime probe could not reach.
  let serialised: string | null = null;

  try {
    serialised = JSON.stringify(invoice);
  } catch {
    serialised = null;
  }

  expect(serialised !== null, "the invoice snapshot survives JSON, so a create can be answered");
  expect(serialised !== null && serialised.includes('"totalMinor":"3125000"'), "with each amount as decimal text");
  expect(serialised !== null && serialised.includes('"total":"312.5000"'), "beside its printed form");

  // Every money column is the database's: the service sent none of them.
  const storedRow = at(db.invoices, 0, "the stored invoice");

  expectEqual(storedRow["subtotal_minor"], "3125000", "the subtotal is stored by the trigger, not by the service");
  expectEqual(storedRow["total_minor"], "3125000", "and the total by invoices_derive_total");
  expectEqual(storedRow["number"], null, "a draft carries no number");
  expectEqual(storedRow["issued_at"], null, "and no issue instant");

  // The money totals are the database's. This is asserted from what the service actually sent rather
  // than from what its source looks like: the invoice row it inserted carries no subtotal, no total and
  // no line total, because `invoices_derive_total` and `invoice_items_sync_totals` own all three.
  const sentInvoice = at(at(db.inserts, 0, "the invoice insert").rows, 0, "the invoice row that was sent");
  const sentLine = at(at(db.inserts, 1, "the line insert").rows, 0, "the line that was sent");

  for (const column of ["subtotal_minor", "total_minor", "amount_paid_minor", "number", "issued_at"]) {
    expect(
      !Object.hasOwn(sentInvoice, column),
      `the service sends no ${column} of its own: the migration's trigger owns it`,
    );
  }

  for (const column of ["line_total_minor", "deleted_at", "version", "id"]) {
    expect(
      !Object.hasOwn(sentLine, column),
      `the service sends no ${column} on a line: the column is generated or defaulted`,
    );
  }

  // What it does send is the row of `0023` minus the generated and defaulted columns.
  expectDeepEqual(
    Object.keys(sentLine).sort(),
    [
      "company_id",
      "description",
      "discount_minor",
      "invoice_id",
      "position",
      "product_id",
      "quantity",
      "service_id",
      "unit",
      "unit_price_minor",
    ],
    "a line is written with exactly the columns it needs",
  );

  // The lines went in one insert, not one per line: rule 17, no query in a loop.
  const invoiceInserts = db.inserts.filter((entry) => entry.table === "invoices");
  const itemInserts = db.inserts.filter((entry) => entry.table === "invoice_items");

  expectEqual(invoiceInserts.length, 1, "the invoice row is one insert");
  expectEqual(itemInserts.length, 1, "and twenty lines would still be one insert");

  // The invoice-level discount is a second write, because `invoices_discount_check` compares it to a
  // subtotal that does not exist until the lines do. The gate asserts the order, not just the result.
  const discountDb = createDb();
  const discounted = await createInvoice({ actor: owner, body: bodyOf({ discount: "12.50" }) }, depsOf(discountDb));
  const discountUpdates = discountDb.updates.filter((entry) => entry.table === "invoices");

  expectEqual(discountUpdates.length, 1, "an invoice discount is one second write");
  expectEqual(at(discountUpdates, 0, "the discount write").values["discount_minor"], 125_000n, "carrying the discount");
  expectEqual(discounted.totals.discountMinor, "125000", "which the re-read reports");
  expectEqual(discounted.totals.totalMinor, "3000000", "and the total is recomputed from it: 312.50 less 12.50");
  expect(
    String(at(discountUpdates, 0, "the discount write").query).includes("status=eq.draft"),
    "scoped to a draft, so it can never touch an issued document",
  );

  // With no discount there is no second write at all.
  const plainDb = createDb();
  await createInvoice({ actor: owner, body: bodyOf() }, depsOf(plainDb));

  expectEqual(plainDb.updates.length, 0, "a create with no invoice discount writes one row and no update");

  // Three lines, one insert.
  const manyDb = createDb();
  const many = await createInvoice(
    {
      actor: owner,
      body: bodyOf({
        lines: [
          { description: "One", unit: "item", quantity: "1", unit_price: "10" },
          { description: "Two", unit: "item", quantity: "2", unit_price: "20" },
          { description: "Three", unit: "item", quantity: "3", unit_price: "30" },
        ],
      }),
    },
    depsOf(manyDb),
  );

  expectEqual(many.lines.length, 3, "three lines were written");
  expectEqual(manyDb.inserts.filter((entry) => entry.table === "invoice_items").length, 1, "in one statement");
  expectDeepEqual(
    many.lines.map((line) => line.position),
    [1, 2, 3],
    "and numbered from one, in the order they were typed",
  );
  expectEqual(many.totals.subtotalMinor, "1400000", "and summed as 1000 + 4000 + 9000 minor units");

  // The fields each ceiling belongs to, named one at a time.
  const refusals: readonly (readonly [string, Record<string, unknown>, string, string])[] = [
    [
      "a client id that is not an id",
      bodyOf({ client_id: "not-a-uuid" }),
      "client_id",
      "invalid_format",
    ],
    [
      "a due date that is not a date",
      bodyOf({ due_at: "next tuesday" }),
      "due_at",
      "invalid_format",
    ],
    [
      "a due date ten years out",
      bodyOf({ due_at: new Date(NOW + 4_000 * 86_400_000).toISOString() }),
      "due_at",
      "too_large",
    ],
    [
      "a currency the platform does not bill in",
      bodyOf({ currency: "EUR" }),
      "currency",
      "invalid_format",
    ],
    [
      "an invoice discount that is not an amount",
      bodyOf({ discount: "free" }),
      "discount",
      "invalid_format",
    ],
    [
      "a tax that is not an amount",
      bodyOf({ tax: "lots" }),
      "tax",
      "invalid_format",
    ],
    [
      "no lines at all",
      bodyOf({ lines: [] }),
      "lines",
      "empty",
    ],
    [
      "more lines than an invoice holds",
      bodyOf({
        lines: Array.from({ length: INVOICE_MAXIMUM_LINES + 1 }, () => ({
          description: "Line",
          unit: "item",
          quantity: "1",
          unit_price: "1",
        })),
      }),
      "lines",
      "too_many",
    ],
    [
      "a line with no description",
      bodyOf({ lines: [{ description: "", unit: "item", quantity: "1", unit_price: "10" }] }),
      "lines[0].description",
      "required",
    ],
    [
      "a unit outside the list",
      bodyOf({ lines: [{ description: "Line", unit: "stone", quantity: "1", unit_price: "10" }] }),
      "lines[0].unit",
      "invalid_format",
    ],
    [
      "a quantity of zero",
      bodyOf({ lines: [{ description: "Line", unit: "item", quantity: "0", unit_price: "10" }] }),
      "lines[0].quantity",
      "too_small",
    ],
    [
      "a quantity past one million",
      bodyOf({ lines: [{ description: "Line", unit: "item", quantity: "1000001", unit_price: "10" }] }),
      "lines[0].quantity",
      "too_large",
    ],
    [
      "a quantity with a fourth decimal",
      bodyOf({ lines: [{ description: "Line", unit: "item", quantity: "1.2345", unit_price: "10" }] }),
      "lines[0].quantity",
      "invalid_format",
    ],
    [
      "a price that is not a price",
      bodyOf({ lines: [{ description: "Line", unit: "item", quantity: "1", unit_price: "free" }] }),
      "lines[0].unit_price",
      "invalid_format",
    ],
    [
      // `price.ts` refuses anything outside its pattern as `invalid_format`; a number that fits the
      // pattern but passes the ceiling is the `too_large` case, handled separately below.
      "a price past the ceiling",
      bodyOf({ lines: [{ description: "Line", unit: "item", quantity: "1", unit_price: "999999999999.9999" }] }),
      "lines[0].unit_price",
      "too_large",
    ],
    [
      "a line discount larger than the line",
      bodyOf({ lines: [{ description: "Line", unit: "item", quantity: "1", unit_price: "10", discount: "11" }] }),
      "lines[0].discount",
      "too_large",
    ],
    [
      "a product and a service on one line",
      bodyOf({
        lines: [
          {
            description: "Line",
            unit: "item",
            quantity: "1",
            unit_price: "10",
            product_id: PRODUCT_A,
            service_id: SERVICE_A,
          },
        ],
      }),
      "lines[0].service_id",
      "invalid_format",
    ],
    [
      // The line is 2.5 hours at 125.00, so the subtotal is 312.50 and 400 is more than it.
      "an invoice discount larger than the subtotal",
      bodyOf({ discount: "400" }),
      "discount",
      "too_large",
    ],


  ];

  for (const [description, body, field, rule] of refusals) {
    const details = await refusalOf(() => createInvoice({ actor: owner, body }, depsOf(createDb())));

    expect(details.length > 0, `the service refuses ${description}`);
    expectEqual(at(details, 0, description).field, field, `naming the field for ${description}`);
    expectEqual(at(details, 0, description).rule, rule, `naming the rule for ${description}`);
  }

  // The boundaries themselves are allowed: a discount equal to the subtotal is a 100% discount, not an
  // error, and a line discount equal to the line is a free line. `invoices_discount_check` says
  // `discount_minor <= subtotal_minor`, and `invoice_items_discount_check` says `<=` as well.
  const wholeDiscount = await createInvoice({ actor: owner, body: bodyOf({ discount: "312.50" }) }, depsOf(createDb()));

  expectEqual(wholeDiscount.totals.totalMinor, "0", "a discount equal to the subtotal is allowed, and totals zero");

  const freeLine = await createInvoice(
    {
      actor: owner,
      body: bodyOf({
        lines: [{ description: "Free", unit: "item", quantity: "1", unit_price: "10", discount: "10" }],
      }),
    },
    depsOf(createDb()),
  );

  expectEqual(at(freeLine.lines, 0, "the free line").lineTotalMinor, "0", "a discount equal to the line is a free line");

  const zeroPrice = await createInvoice(
    {
      actor: owner,
      body: bodyOf({ lines: [{ description: "Free", unit: "item", quantity: "1", unit_price: "0" }] }),
    },
    depsOf(createDb()),
  );

  expectEqual(at(zeroPrice.lines, 0, "the zero price line").lineTotalMinor, "0", "a price of zero is a valid price");

  // Every broken field is named at once, and in the order the screen reads them.
  const broken = await refusalOf(() =>
    createInvoice(
      {
        actor: owner,
        body: bodyOf({
          client_id: "nope",
          currency: "EUR",
          lines: [
            { description: "", unit: "stone", quantity: "0", unit_price: "free" },
            { description: "Good", unit: "item", quantity: "1", unit_price: "10" },
            { description: "Bad price", unit: "item", quantity: "1", unit_price: "1 200" },
          ],
        }),
      },
      depsOf(createDb()),
    ),
  );

  expectDeepEqual(
    broken.map((detail) => detail.field),
    [
      "client_id",
      "currency",
      "lines[0].description",
      "lines[0].unit",
      "lines[0].quantity",
      "lines[0].unit_price",
      "lines[2].unit_price",
    ],
    "every broken field is named once, the lines in the order they were typed",
  );

  // A struck-out line on a list of twenty is marked on its own row, not against the whole list.
  expect(
    broken.some((detail) => detail.field === "lines[0].unit_price"),
    "a line's own box is named for a line that failed",
  );

  // The memo and a line description are sanitised rather than refused: a merchant pasting text is not
  // making an error, and the ceiling is what the column holds.
  const longDescription = "x".repeat(INVOICE_ITEM_DESCRIPTION_LIMITS.max + 50);
  const sanitised = await refusalOf(() =>
    createInvoice(
      {
        actor: owner,
        body: bodyOf({
          memo: "Thank you for your business",
          lines: [{ description: longDescription, unit: "item", quantity: "1", unit_price: "10" }],
        }),
      },
      depsOf(createDb()),
    ),
  );

  expectDeepEqual(sanitised, [], "an over-long description is truncated to the column, not refused");
}

/* ---- 4. the tenancy ---- */

async function checkTenancy(): Promise<void> {
  // Only the owner writes an invoice, exactly as only the owner writes the book it bills from. Every
  // other role is refused by the role, before the body is even parsed - so the answer is a permission
  // code and never a validation detail that would let an office account probe the form's rules.
  for (const roles of [["compliance_kyc"], ["finance_ops"], ["support"], ["ceo"], ["super_admin"], ["blogger"]] as const) {
    const code = await codeOf(() =>
      createInvoice(
        { actor: actorOf([...roles], COMPANY_A, { userId: OFFICE_ID }), body: bodyOf() },
        depsOf(createDb()),
      ),
    );

    expectEqual(code, "PERMISSION_DENIED", `the role ${roles[0]} may not write an invoice`);
  }

  // A platform account with no company cannot write into one.
  expectEqual(
    await codeOf(() => createInvoice({ actor: desk, body: bodyOf() }, depsOf(createDb()))),
    "PERMISSION_DENIED",
    "an account with no company cannot write an invoice",
  );

  // Another merchant's client is the same answer as a client that does not exist: a 404, never a 403
  // that would confirm the id belongs to somebody.
  for (const [description, clientId] of [
    ["another merchant's client", CLIENT_B],
    ["a client that does not exist", "018f2b8a-5555-4c2d-9c3e-0000000000ff"],
  ] as const) {
    const db = createDb();

    expectEqual(
      await codeOf(() => createInvoice({ actor: owner, body: bodyOf({ client_id: clientId }) }, depsOf(db))),
      "RESOURCE_NOT_FOUND",
      `${description} answers not found`,
    );
    expectEqual(db.invoices.length, 0, `and ${description} writes no invoice`);
  }

  // The company on the row is the session's, never the body's.
  const db = createDb();
  await createInvoice({ actor: owner, body: bodyOf() }, depsOf(db));

  expectEqual(at(db.invoices, 0, "the invoice")["company_id"], COMPANY_A, "the row belongs to the session's company");
  expectEqual(at(db.items, 0, "the line")["company_id"], COMPANY_A, "and so does every line");

  // The same body for another merchant writes into their company, and their own client.
  const sharedDb = createDb();
  await createInvoice({ actor: owner, body: bodyOf() }, depsOf(sharedDb));
  await createInvoice(
    { actor: otherOwner, body: bodyOf({ client_id: CLIENT_B }) },
    depsOf(sharedDb),
  );

  expectEqual(sharedDb.invoices.length, 2, "two merchants writing the same body write two invoices");
  expectEqual(at(sharedDb.invoices, 1, "the second invoice")["company_id"], COMPANY_B, "each into its own company");

  // The catalogue reference is scoped by `invoice_items_guard_catalogue`: the merchant's own product may
  // be billed, and a product that exists but belongs to somebody else may not.
  const own = createDb();
  const ownInvoice = await createInvoice(
    {
      actor: owner,
      body: bodyOf({
        lines: [
          { description: "Desk lamp", unit: "item", quantity: "1", unit_price: "42.50", product_id: PRODUCT_A },
        ],
      }),
    },
    depsOf(own),
  );

  expectEqual(at(ownInvoice.lines, 0, "the line").productId, PRODUCT_A, "the merchant's own product may be billed");

  // A product id that belongs to the other merchant: the trigger refuses the line, and the invoice the
  // request had already written is removed rather than left as an empty draft.
  const foreign = createDb();
  foreign.products.push({ ...at(foreign.products, 0, "the product"), id: "018f2b8a-6666-4c2d-9c3e-0000000000ff", company_id: COMPANY_B });

  let foreignCode: string | null = null;
  let foreignDetails: readonly { readonly field?: unknown; readonly rule?: unknown }[] = [];

  try {
    await createInvoice(
      {
        actor: owner,
        body: bodyOf({
          lines: [
            { description: "Borrowed", unit: "item", quantity: "1", unit_price: "10", product_id: "018f2b8a-6666-4c2d-9c3e-0000000000ff" },
          ],
        }),
      },
      depsOf(foreign),
    );
  } catch (error) {
    foreignCode = isAppError(error) ? error.code : "not-an-app-error";
    foreignDetails = isAppError(error) && error.code === "VALIDATION_FAILED" ? error.details : [];
  }

  expectEqual(foreignCode, "VALIDATION_FAILED", "another merchant's product cannot be billed");
  expectEqual(at(foreignDetails, 0, "the refusal").field, "lines[0].product_id", "the refusal names the line's box");
  expectEqual(at(foreignDetails, 0, "the refusal").rule, "not_found", "and says the entry is not there");
  expect(at(foreign.invoices, 0, "the abandoned invoice")["deleted_at"] !== null, "and the invoice written for it is removed");

  // A client whose stored email the invoice cannot print is refused before the write, not by PostgREST.
  const badEmailDb = createDb();
  badEmailDb.clients.push(clientRow({ id: CLIENT_B, companyId: COMPANY_A, name: "Stale Book", email: "not-an-email" }));

  const badEmail = await refusalOf(() =>
    createInvoice({ actor: owner, body: bodyOf({ client_id: CLIENT_B }) }, depsOf(badEmailDb)),
  );

  expectEqual(at(badEmail, 0, "the refusal").field, "client_id", "an address the invoice cannot print names the client");
  expectEqual(badEmailDb.invoices.length, 0, "and writes nothing");
}

/* ---- 5 and 6. the draft, and the compensation ---- */

async function checkCompensation(): Promise<void> {
  const db = createDb();

  db.failItems = true;

  let code: string | null = null;

  try {
    await createInvoice({ actor: owner, body: bodyOf() }, depsOf(db));
  } catch (error) {
    code = isAppError(error) ? error.code : "not-an-app-error";
  }

  expectEqual(code, "VALIDATION_FAILED", "a lines insert the database refuses is reported as a validation failure");

  // The invoice row is still there, because PostgREST has no transaction across two requests - but it is
  // marked deleted, so the merchant's list never shows a draft the request reported as failed.
  const abandoned = at(db.invoices, 0, "the abandoned invoice");

  expect(abandoned["deleted_at"] !== null, "the invoice written for it is soft deleted");
  expectEqual(db.updates.filter((entry) => entry.table === "invoices").length, 1, "by one scoped update");
  expect(
    String(at(db.updates, 0, "the compensating update").query).includes("status=eq.draft"),
    "and only while it is still a draft, so it can never touch an issued document",
  );

  // A read afterwards does not find it, which is what the merchant sees.
  let readCode: string | null = null;

  try {
    await getInvoice({ actor: owner, invoiceId: String(abandoned["id"]) }, depsOf(db));
  } catch (error) {
    readCode = isAppError(error) ? error.code : "not-an-app-error";
  }

  expectEqual(readCode, "RESOURCE_NOT_FOUND", "and a read of it afterwards is a 404, as a removal is");
}

/* ---- 7. the audit ---- */

async function checkAudit(): Promise<void> {
  const db = createDb();
  const audit = createInMemoryAuditTrail();
  const invoice = await createInvoice({ actor: owner, body: bodyOf({ memo: "Thanks for the work" }) }, depsOf(db, audit));

  const created = audit.entries.filter((entry) => entry.action === INVOICE_CREATED_AUDIT_ACTION);

  expectEqual(created.length, 1, "a create writes one audit entry");
  expectEqual(audit.entries.length, 1, "and nothing else");

  const entry = at(created, 0, "the create entry");
  const payload = entry.payload as Readonly<Record<string, unknown>>;

  expectEqual(entry.entityType, "invoice", "the entry names the entity");
  expectEqual(entry.entityId, invoice.id, "and the row");
  expectEqual(entry.companyId, COMPANY_A, "and the company");
  expectEqual(entry.actorUserId, OWNER_ID, "and the actor");
  expectEqual(payload["line_count"], 1, "the payload says how many lines");
  expectEqual(payload["total_minor"], "3125000", "and what the document totals");
  expectEqual(payload["currency"], "USD", "and in what currency");

  const serialised = JSON.stringify(audit.entries);

  for (const [secret, why] of [
    ["Acme Ltd", "the client's name"],
    ["billing@acme.example", "the client's email address"],
    ["Thanks for the work", "the memo"],
    ["Consulting", "a line's description"],
    ["Market Street", "the client's address"],
  ] as const) {
    expect(!serialised.includes(secret), `the trail never carries ${why}`);
  }

  // The compensating removal is audited too, and says why it happened without repeating a value.
  const abandonedAudit = createInMemoryAuditTrail();
  const abandonedDb = createDb();

  abandonedDb.failItems = true;

  await refusalOf(() => createInvoice({ actor: owner, body: bodyOf({ lines: [{ description: "Secret line", unit: "item", quantity: "1", unit_price: "10" }] }) }, depsOf(abandonedDb, abandonedAudit)));

  const removals = abandonedAudit.entries.filter((entry) => entry.action === INVOICE_ABANDONED_AUDIT_ACTION);

  expectEqual(removals.length, 1, "an abandoned create is recorded");
  expect(!JSON.stringify(removals).includes("Secret line"), "without repeating the line that caused it");

  // An audit sink that is down never fails the write it records.
  const deafTrail: AuditTrail = {
    append(): Promise<void> {
      return Promise.reject(new Error("the sink is down"));
    },
  };
  const deafDb = createDb();
  const survived = await createInvoice({ actor: owner, body: bodyOf() }, depsOf(deafDb, deafTrail));

  expectEqual(survived.status, "draft", "a create succeeds when its audit sink is down");
}

/* ---- the client and catalogue selectors ---- */

async function checkSelectors(): Promise<void> {
  const db = createDb();
  const options = await listInvoiceClientOptions({ actor: owner }, { rest: createInvoiceRest(db) });

  expectEqual(options.clients.length, 1, "the selector reads the merchant's own live clients");
  expectEqual(at(options.clients, 0, "the option").name, "Acme Ltd", "with the name the invoice prints");
  expectEqual(options.truncated, false, "and says whether the book continues");

  // Only four columns leave the database for a selector that prints three facts.
  const clientQuery = at(
    db.queries.filter((query) => query.startsWith("clients?")),
    0,
    "the client option query",
  );

  expect(clientQuery.includes("select=id,name,email,city,created_at"), "the selector selects its columns one by one");
  expect(!clientQuery.includes("notes"), "and not the ones it does not print");
  expect(clientQuery.includes("company_id=eq."), "scoped to the session's company");
  expect(clientQuery.includes("deleted_at=is.null"), "and to the live rows");
  expect(
    clientQuery.includes(`limit=${String(INVOICE_CLIENT_OPTION_LIMIT + 1)}`),
    "reading one row past the ceiling so the book's continuation is known",
  );

  // The role applies to a selector exactly as to a write: an account that may not read the book is not
  // offered a client to bill.
  let selectorCode: string | null = null;

  try {
    await listInvoiceClientOptions({ actor: desk }, { rest: createInvoiceRest(db) });
  } catch (error) {
    selectorCode = isAppError(error) ? error.code : "not-an-app-error";
  }

  expectEqual(selectorCode, "PERMISSION_DENIED", "the selector applies the client book's own role");

  // The catalogue picker, per kind, from the merchant's own tables.
  const catalogueDb = createDb();
  const products = await listInvoiceCatalogueOptions({ rest: createInvoiceRest(catalogueDb) }, { actor: owner, kind: "product" });
  const services = await listInvoiceCatalogueOptions({ rest: createInvoiceRest(catalogueDb) }, { actor: owner, kind: "service" });

  expectEqual(products.entries.length, 1, "the product picker reads the product catalogue");
  expectEqual(at(products.entries, 0, "the product").kind, "product", "and names its kind");
  expectEqual(at(products.entries, 0, "the product").unitPrice, "42.5000", "and the price the line fills with");
  expectEqual(services.entries.length, 1, "the service picker reads the service catalogue");
  expectEqual(at(services.entries, 0, "the service").unit, "hour", "with the unit the line fills with");

  // Filling a line from the catalogue produces one the service accepts, with the link kept.
  const filled = await createInvoice(
    {
      actor: owner,
      body: bodyOf({
        lines: [
          {
            description: "Consulting",
            unit: "hour",
            quantity: "1",
            unit_price: at(services.entries, 0, "the service").unitPrice,
            service_id: SERVICE_A,
          },
        ],
      }),
    },
    depsOf(createDb()),
  );

  expectEqual(at(filled.lines, 0, "the filled line").serviceId, SERVICE_A, "the filled line keeps its link");
  expectEqual(at(filled.lines, 0, "the filled line").productId, null, "and claims no product");
}

/* ---- 9. the line editor: add, edit, remove (STEP 113) ---- */

/** Build a draft with `count` lines, and hand back the database so the test can read it. */
async function draftWith(count: number): Promise<{ readonly db: InvoiceDb; readonly invoiceId: string }> {
  const db = createDb();
  const invoice = await createInvoice(
    {
      actor: owner,
      body: bodyOf({
        lines: Array.from({ length: count }, (_, index) => ({
          description: `Line ${String(index + 1)}`,
          unit: "item",
          quantity: "1",
          unit_price: "10",
        })),
      }),
    },
    depsOf(db),
  );

  return { db, invoiceId: invoice.id };
}

/** One parsed line, through the create path's own parser. */
function parsedLine(overrides: Readonly<Record<string, unknown>> = {}): ParsedLine {
  return parseInvoiceLine({
    description: "Consulting",
    unit: "hour",
    quantity: "2.5",
    unit_price: "125.00",
    discount: "",
    ...overrides,
  });
}

async function checkLineEditor(): Promise<void> {
  // Adding a line appends at the end of a dense list, and the database totals it.
  const { db, invoiceId } = await draftWith(2);
  const line = await addInvoiceLine(
    { actor: owner, invoiceId, line: parsedLine() },
    lineDepsOf(db),
  );

  expectEqual(line.position, 3, "a new line takes the position after the last");
  expectEqual(line.quantity, "2.5", "and prints the quantity it was given");
  expectEqual(line.unitPrice, "125.0000", "and the price");
  expectEqual(line.lineTotalMinor, "3125000", "with the total the database generated");

  const parent = at(db.invoices, 0, "the invoice");

  // Two lines at 10.00 each, then one at 2.5 hours and 125.00: 200000 + 3125000.
  expectEqual(parent["subtotal_minor"], "3325000", "and the parent's subtotal now sums three lines");

  // The service sent no total: the sum is the trigger's.
  const sentLine = at(at(db.inserts, db.inserts.length - 1, "the line insert").rows, 0, "the line row");

  for (const column of ["line_total_minor", "deleted_at", "version", "id"]) {
    expect(!Object.hasOwn(sentLine, column), `an added line sends no ${column}`);
  }

  expectEqual(sentLine["quantity"], "2.5", "the quantity crosses the wire as the decimal the column stores");

  // The count ceiling is enforced before the write.
  const full = await draftWith(INVOICE_MAXIMUM_LINES);
  const tooMany = await refusalOf(() =>
    addInvoiceLine({ actor: owner, invoiceId: full.invoiceId, line: parsedLine() }, lineDepsOf(full.db)),
  );

  expectEqual(at(tooMany, 0, "the ceiling refusal").field, "lines", "a full invoice refuses another line");
  expectEqual(at(tooMany, 0, "the ceiling refusal").rule, "too_many", "as too_many");
  expectEqual(full.db.items.length, INVOICE_MAXIMUM_LINES, "and writes nothing");

  // An edit replaces the whole line and revalidates with the create path's rules.
  const editing = await draftWith(2);
  const second = at(
    await readLiveLinesForTest(editing.db, editing.invoiceId),
    1,
    "the second line",
  );
  const edited = await updateInvoiceLine(
    {
      actor: owner,
      invoiceId: editing.invoiceId,
      lineId: second.id,
      line: parsedLine({ description: "Revised", quantity: "3", unit_price: "20.00" }),
    },
    lineDepsOf(editing.db),
  );

  expectEqual(edited.description, "Revised", "an edit replaces the description");
  expectEqual(edited.position, second.position, "and leaves the position alone");
  expectEqual(edited.lineTotalMinor, "600000", "with a total the database recomputed");
  expectEqual(
    at(editing.db.invoices, 0, "the invoice")["subtotal_minor"],
    "700000",
    "and the subtotal follows: 10 + 60",
  );

  // "Full discount support": a line may be discounted to zero, and past its gross it is refused.
  const free = await updateInvoiceLine(
    {
      actor: owner,
      invoiceId: editing.invoiceId,
      lineId: second.id,
      line: parsedLine({ quantity: "1", unit_price: "20.00", discount: "20.00" }),
    },
    lineDepsOf(editing.db),
  );

  expectEqual(free.lineTotalMinor, "0", "a discount equal to the line makes it free");
  expectEqual(free.discount, "20.0000", "and is reported as the merchant typed it");

  const overDiscount = await refusalOf(() =>
    updateInvoiceLine(
      {
        actor: owner,
        invoiceId: editing.invoiceId,
        lineId: second.id,
        line: parsedLine({ quantity: "1", unit_price: "20.00", discount: "20.01" }),
      },
      lineDepsOf(editing.db),
    ),
  );

  expectEqual(at(overDiscount, 0, "the discount refusal").field, "discount", "a discount past the line names discount");
  expectEqual(at(overDiscount, 0, "the discount refusal").rule, "too_large", "as too_large");

  // The bare field names the editor needs, not the create path's `lines[0].` prefix.
  for (const [description, body, field] of [
    ["a blank description", { description: "  " }, "description"],
    ["an unknown unit", { unit: "stone" }, "unit"],
    ["a zero quantity", { quantity: "0" }, "quantity"],
    ["a fourth decimal", { quantity: "1.2345" }, "quantity"],
    ["a price that is not a price", { unit_price: "free" }, "unit_price"],
    ["both catalogue references", { product_id: PRODUCT_A, service_id: SERVICE_A }, "service_id"],
  ] as const) {
    const details = await refusalOf(() =>
      updateInvoiceLine(
        { actor: owner, invoiceId: editing.invoiceId, lineId: second.id, line: parsedLine(body) },
        lineDepsOf(editing.db),
      ),
    );

    expectEqual(at(details, 0, description).field, field, `the editor refuses ${description} by bare field name`);
    expect(!String(at(details, 0, description).field).startsWith("lines["), `and not as a create path row for ${description}`);
  }

  // A removal soft deletes the row and closes the gap.
  const removing = await draftWith(3);
  const before = await readLiveLinesForTest(removing.db, removing.invoiceId);
  const result = await removeInvoiceLine(
    { actor: owner, invoiceId: removing.invoiceId, lineId: at(before, 0, "the first line").id },
    lineDepsOf(removing.db),
  );

  expectEqual(result.lines.length, 2, "two lines survive");
  expectDeepEqual(
    result.lines.map((entry) => entry.position),
    [1, 2],
    "and the positions are dense again, not 2 and 3",
  );
  expectDeepEqual(
    result.lines.map((entry) => entry.description),
    ["Line 2", "Line 3"],
    "in the order they were written",
  );
  expectEqual(removing.db.items.length, 3, "the removed row stays in the table");
  expect(
    at(removing.db.items, 0, "the removed row")["deleted_at"] !== null,
    "as a soft delete, because a draft may have been exported",
  );
  expectEqual(
    at(removing.db.invoices, 0, "the invoice")["subtotal_minor"],
    "200000",
    "and the subtotal is the two survivors: 10 + 10",
  );

  // The last line cannot be removed: an invoice with no lines is not a document `0022` can total.
  const lonely = await draftWith(1);
  const last = await refusalOf(() =>
    removeInvoiceLine(
      { actor: owner, invoiceId: lonely.invoiceId, lineId: String(at(lonely.db.items, 0, "the only line")["id"]) },
      lineDepsOf(lonely.db),
    ),
  );

  expectEqual(at(last, 0, "the last line refusal").field, "lines", "the last line is refused");
  expectEqual(at(last, 0, "the last line refusal").rule, "empty", "as empty");
  expectEqual(lonely.db.items.length, 1, "and nothing is removed");

  // A line of another invoice under the path is a 404, not an edit.
  const twoDrafts = await draftWith(1);
  const otherInvoice = await createInvoice(
    { actor: owner, body: bodyOf({ lines: [{ description: "Elsewhere", unit: "item", quantity: "1", unit_price: "5" }] }) },
    depsOf(twoDrafts.db),
  );
  const foreignLine = at(
    await readLiveLinesForTest(twoDrafts.db, otherInvoice.id),
    0,
    "the other invoice's line",
  );

  expectEqual(
    await lineCodeOf(() =>
      updateInvoiceLine(
        { actor: owner, invoiceId: twoDrafts.invoiceId, lineId: foreignLine.id, line: parsedLine() },
        lineDepsOf(twoDrafts.db),
      ),
    ),
    "RESOURCE_NOT_FOUND",
    "a line named under the wrong invoice is not found",
  );

  expectEqual(
    await lineCodeOf(() =>
      removeInvoiceLine(
        { actor: owner, invoiceId: twoDrafts.invoiceId, lineId: foreignLine.id },
        lineDepsOf(twoDrafts.db),
      ),
    ),
    "RESOURCE_NOT_FOUND",
    "and cannot be removed through the wrong invoice either",
  );

  // A line id that belongs to another merchant is the same 404, never a 403 that confirms it exists.
  expectEqual(
    await lineCodeOf(() =>
      updateInvoiceLine(
        { actor: otherOwner, invoiceId, lineId: second.id, line: parsedLine() },
        lineDepsOf(editing.db),
      ),
    ),
    "RESOURCE_NOT_FOUND",
    "another merchant's invoice is not found, so neither is its line",
  );

  // The role applies: it is the invoice's own list, not a second one.
  for (const roles of [["compliance_kyc"], ["finance_ops"], ["support"], ["ceo"], ["super_admin"], ["blogger"]] as const) {
    expectEqual(
      await lineCodeOf(() =>
        addInvoiceLine(
          { actor: actorOf([...roles], COMPANY_A, { userId: OFFICE_ID }), invoiceId, line: parsedLine() },
          lineDepsOf(db),
        ),
      ),
      "PERMISSION_DENIED",
      `the role ${roles[0]} may not add a line`,
    );
  }

  // The draft lock: an invoice that has left draft refuses every line write, and says why.
  const issued = await draftWith(2);
  const issuedLine = at(await readLiveLinesForTest(issued.db, issued.invoiceId), 0, "the first line");

  at(issued.db.invoices, 0, "the issued invoice")["status"] = "sent";

  for (const [description, run] of [
    ["add", () => addInvoiceLine({ actor: owner, invoiceId: issued.invoiceId, line: parsedLine() }, lineDepsOf(issued.db))],
    [
      "edit",
      () =>
        updateInvoiceLine(
          { actor: owner, invoiceId: issued.invoiceId, lineId: issuedLine.id, line: parsedLine() },
          lineDepsOf(issued.db),
        ),
    ],
    ["remove", () => removeInvoiceLine({ actor: owner, invoiceId: issued.invoiceId, lineId: issuedLine.id }, lineDepsOf(issued.db))],
  ] as const) {
    expectEqual(await lineCodeOf(run), "CONFLICT", `a sent invoice refuses a line ${description}`);
  }

  expectEqual(
    at(issued.db.items, 0, "the untouched line")["description"],
    "Line 1",
    "and nothing about the issued document changed",
  );
}

/* ---- 10. the line editor's audit trail ---- */

async function checkLineAudit(): Promise<void> {
  const db = createDb();
  const audit = createInMemoryAuditTrail();
  const invoice = await createInvoice(
    {
      actor: owner,
      body: bodyOf({ lines: [{ description: "Secret work", unit: "item", quantity: "1", unit_price: "10" }] }),
    },
    depsOf(db, audit),
  );
  const before = audit.entries.length;
  const added = await addInvoiceLine(
    { actor: owner, invoiceId: invoice.id, line: parsedLine({ description: "Private note" }) },
    lineDepsOf(db, audit),
  );

  const addedEntries = audit.entries.slice(before).filter((entry) => entry.action === INVOICE_LINE_ADDED_AUDIT_ACTION);

  expectEqual(addedEntries.length, 1, "adding a line writes one entry");
  expectEqual(at(addedEntries, 0, "the add entry").entityId, added.id, "naming the line");
  expectEqual(at(addedEntries, 0, "the add entry").companyId, COMPANY_A, "and the company");
  expectEqual(at(addedEntries, 0, "the add entry").actorUserId, OWNER_ID, "and the actor");

  const afterAdd = audit.entries.length;

  await updateInvoiceLine(
    { actor: owner, invoiceId: invoice.id, lineId: added.id, line: parsedLine({ description: "Revised note" }) },
    lineDepsOf(db, audit),
  );
  await removeInvoiceLine(
    { actor: owner, invoiceId: invoice.id, lineId: added.id },
    lineDepsOf(db, audit),
  );

  const later = audit.entries.slice(afterAdd);

  expectDeepEqual(
    later.map((entry) => entry.action),
    [INVOICE_LINE_UPDATED_AUDIT_ACTION, INVOICE_LINE_REMOVED_AUDIT_ACTION],
    "an edit and a removal each write their own entry",
  );

  // The trail never carries what the line said: a description is free text a merchant pasted.
  const serialised = JSON.stringify(audit.entries);

  for (const secret of ["Secret work", "Private note", "Revised note"]) {
    expect(!serialised.includes(secret), `the trail never repeats the line text ${JSON.stringify(secret)}`);
  }

  // `shifted` is the fact an investigation needs about a removal, and it is a count.
  const removedEntry = later[1];

  expectEqual(
    removedEntry === undefined ? null : (removedEntry.payload as Readonly<Record<string, unknown>>)["shifted"],
    0,
    "and a removal says how many rows it moved up",
  );
}

/* ---- 10b. the line editor: ordering (STEP 113 step 2) ---- */

async function checkLineOrder(): Promise<void> {
  const { db, invoiceId } = await draftWith(3);
  const positionsOf = async (): Promise<readonly number[]> =>
    (await readLiveLinesForTest(db, invoiceId)).map((line) => line.position);
  const descriptionsOf = async (): Promise<readonly string[]> =>
    (await readLiveLinesForTest(db, invoiceId)).map((line) => line.description);

  expectDeepEqual(await positionsOf(), [1, 2, 3], "a fresh draft is a dense list");
  expectDeepEqual(await descriptionsOf(), ["Line 1", "Line 2", "Line 3"], "in the order it was written");

  const lines = await readLiveLinesForTest(db, invoiceId);
  const second = at(lines, 1, "the second line");

  // Move down: the second and third exchange places.
  const movedDown = await moveInvoiceLine(
    { actor: owner, invoiceId, lineId: second.id, direction: "down" },
    lineDepsOf(db),
  );

  expectDeepEqual(
    movedDown.lines.map((line) => line.description),
    ["Line 1", "Line 3", "Line 2"],
    "moving down puts the line after its neighbour",
  );
  expectDeepEqual(await positionsOf(), [1, 2, 3], "and the positions stay dense");
  expectEqual(movedDown.movedLineId, second.id, "the answer names the line that moved");
  expectEqual(at(movedDown.lines, 2, "the moved line").position, 3, "which is now last");

  // Move it back up.
  const movedUp = await moveInvoiceLine(
    { actor: owner, invoiceId, lineId: second.id, direction: "up" },
    lineDepsOf(db),
  );

  expectDeepEqual(
    movedUp.lines.map((line) => line.description),
    ["Line 1", "Line 2", "Line 3"],
    "moving up restores the order",
  );
  expectDeepEqual(await positionsOf(), [1, 2, 3], "with the positions still dense");

  // ---- the unique index is satisfied after every write, not just at the end
  db.updates.length = 0;
  db.strictPositions = true;

  await moveInvoiceLine(
    { actor: owner, invoiceId, lineId: second.id, direction: "down" },
    lineDepsOf(db),
  );

  const positionWrites = db.updates.filter((entry) => entry.values["position"] !== undefined);

  expectEqual(positionWrites.length, 3, "a swap is exactly three position writes, not two and not a loop");
  expect(
    positionWrites.every((entry) => Number(entry.values["position"]) >= 1),
    "each parked or exchanged position satisfies position >= 1",
  );

  // The parking position is one past the highest live position, so nothing already holds it.
  expectEqual(
    Number(at(positionWrites, 0, "the parking write").values["position"]),
    4,
    "the first write parks the line one past the end, a position no live row holds",
  );
  expect(db.strictPositions, "and the fixture checked every intermediate write against the index");

  // Moving past either end is a no-op that answers with the list, not a refusal.
  const first = at(await readLiveLinesForTest(db, invoiceId), 0, "the first line");
  const atTop = await moveInvoiceLine(
    { actor: owner, invoiceId, lineId: first.id, direction: "up" },
    lineDepsOf(db),
  );

  expectDeepEqual(
    atTop.lines.map((line) => line.position),
    [1, 2, 3],
    "moving the first line up leaves the order as it was",
  );
  expectEqual(
    db.updates.filter((entry) => entry.values["position"] !== undefined).length,
    3,
    "and writes nothing, because a move that cannot happen is a no-op",
  );

  const last = at(await readLiveLinesForTest(db, invoiceId), 2, "the last line");
  const atBottom = await moveInvoiceLine(
    { actor: owner, invoiceId, lineId: last.id, direction: "down" },
    lineDepsOf(db),
  );

  expectEqual(atBottom.lines.length, 3, "moving the last line down also answers with the list");

  // A removal then a move: the compaction and the swap have to agree about what the list is.
  db.strictPositions = true;
  db.updates.length = 0;

  const compacted = await removeInvoiceLine(
    { actor: owner, invoiceId, lineId: at(await readLiveLinesForTest(db, invoiceId), 0, "the first line").id },
    lineDepsOf(db),
  );

  expectDeepEqual(
    compacted.lines.map((line) => line.position),
    [1, 2],
    "a removal leaves a dense list of two",
  );

  const reordered = await moveInvoiceLine(
    { actor: owner, invoiceId, lineId: at(compacted.lines, 1, "the remaining last line").id, direction: "up" },
    lineDepsOf(db),
  );

  expectDeepEqual(
    reordered.lines.map((line) => line.position),
    [1, 2],
    "and a move on the compacted list is still dense",
  );

  // An unknown line, another merchant's invoice, and a bad direction all refuse.
  expectEqual(
    await lineCodeOf(() =>
      moveInvoiceLine(
        { actor: owner, invoiceId, lineId: "018f2b8a-5555-4c2d-9c3e-0000000000ff", direction: "up" },
        lineDepsOf(db),
      ),
    ),
    "RESOURCE_NOT_FOUND",
    "moving a line that is not there is a 404",
  );

  expectEqual(
    await lineCodeOf(() =>
      moveInvoiceLine({ actor: otherOwner, invoiceId, lineId: second.id, direction: "up" }, lineDepsOf(db)),
    ),
    "RESOURCE_NOT_FOUND",
    "and another merchant's invoice is not found at all",
  );

  // The role applies, and the draft lock applies.
  expectEqual(
    await lineCodeOf(() =>
      moveInvoiceLine(
        { actor: actorOf(["finance_ops"], COMPANY_A, { userId: OFFICE_ID }), invoiceId, lineId: second.id, direction: "up" },
        lineDepsOf(db),
      ),
    ),
    "PERMISSION_DENIED",
    "an office role may not reorder a merchant's invoice",
  );

  const issued = await draftWith(2);
  const issuedLines = await readLiveLinesForTest(issued.db, issued.invoiceId);

  at(issued.db.invoices, 0, "the issued invoice")["status"] = "sending";

  expectEqual(
    await lineCodeOf(() =>
      moveInvoiceLine(
        { actor: owner, invoiceId: issued.invoiceId, lineId: at(issuedLines, 0, "the first line").id, direction: "down" },
        lineDepsOf(issued.db),
      ),
    ),
    "CONFLICT",
    "a document that has left draft cannot be reordered",
  );

  // The move is audited with the positions, and never with the line's text.
  const audit = createInMemoryAuditTrail();
  const audited = await draftWith(2);
  const auditLines = await readLiveLinesForTest(audited.db, audited.invoiceId);

  await moveInvoiceLine(
    { actor: owner, invoiceId: audited.invoiceId, lineId: at(auditLines, 0, "the first line").id, direction: "down" },
    lineDepsOf(audited.db, audit),
  );

  const moves = audit.entries.filter((entry) => entry.action === INVOICE_LINE_MOVED_AUDIT_ACTION);

  expectEqual(moves.length, 1, "a move writes one entry");
  expectEqual(
    (at(moves, 0, "the move entry").payload as Readonly<Record<string, unknown>>)["direction"],
    "down",
    "naming the direction",
  );
  expectEqual(
    (at(moves, 0, "the move entry").payload as Readonly<Record<string, unknown>>)["from_position"],
    1,
    "and where the line came from",
  );
  expect(!JSON.stringify(audit.entries).includes("Line 1"), "and never the line's text");
}

/* ---- 11. the line editor's sources ---- */

async function checkLineSources(): Promise<void> {
  const codeOf = (source: string): string =>
    source
      .split("\n")
      .filter((line) => {
        const trimmed = line.trim();

        return !trimmed.startsWith("*") && !trimmed.startsWith("//") && !trimmed.startsWith("/*");
      })
      .join("\n");

  for (const path of [
    "services/invoices/invoice-lines.ts",
    "app/api/invoices/[id]/lines/route.ts",
    "app/api/invoices/[id]/lines/[lineId]/route.ts",
  ]) {
    const source = await readRepositoryFile(path);

    expect(source.length > 0, `${path} exists`);
    expect(source.split("\n", 1)[0]?.trim() === `// path: ${path}`, `${path} starts with its path comment`);
    expect(!/[^\u0009\u000a\u000d\u0020-\u007e]/u.test(source.replaceAll("\ufeff", "")), `${path} is ASCII only`);
  }

  const lines = await readRepositoryFile("services/invoices/invoice-lines.ts");
  const linesCode = codeOf(lines);

  // The rules are the create path's, not a second copy. The service takes an already-parsed line and the
  // route is what parses it, with `parseInvoiceLine` - the create path's own entry point.
  expect(!linesCode.includes("function parseLine"), "the line service defines no second parser");
  expect(linesCode.includes("ParsedInvoiceLine"), "it takes the create path's parsed line type instead");

  const addRoute = await readRepositoryFile("app/api/invoices/[id]/lines/route.ts");
  const editRoute = await readRepositoryFile("app/api/invoices/[id]/lines/[lineId]/route.ts");

  expect(addRoute.includes("parseInvoiceLine("), "the add route parses with the create path's parser");
  expect(editRoute.includes("parseInvoiceLine("), "and so does the edit route");
  expect(!/parseFloat|Number\(/u.test(linesCode), "no amount passes through a float parse");

  // The totals are the database's.
  expect(!linesCode.includes("subtotal_minor"), "the editor never writes a subtotal");

  // A row the editor sends: the fields of `rowOfLine`. Neither carries a money total, because the
  // generated column and the trigger own both.
  // The end anchor is the function that follows the builder, not a comment that names it earlier.
  const rowOfLineBlock = linesCode.slice(
    linesCode.indexOf("function rowOfLine("),
    linesCode.indexOf("function highestPosition("),
  );

  expect(rowOfLineBlock.length > 0, "the row builder is where the gate expects it");
  expect(!rowOfLineBlock.includes("line_total_minor"), "a line row carries no generated total");
  expect(!rowOfLineBlock.includes("total_minor"), "and no invoice total");

  // The add is one insert, and a removal's compaction is bounded by the rows after it.
  expect(linesCode.includes("insertReturning("), "a line is added by one returning insert");
  expect(linesCode.includes("deleted_at: new Date("), "and removed by a soft delete");

  // The routes check the token before the session and before the body.
  for (const path of ["app/api/invoices/[id]/lines/route.ts", "app/api/invoices/[id]/lines/[lineId]/route.ts"]) {
    const source = codeOf(await readRepositoryFile(path));

    expect(source.includes("requireCsrfToken("), `${path} checks the token`);
    expect(
      source.indexOf("requireCsrfToken(") < source.indexOf("readRequestActor("),
      `${path} checks it before the session`,
    );
    expect(source.includes("PAYLOAD_TOO_LARGE"), `${path} bounds the body`);
  }

  const csrf = await readRepositoryFile("lib/security/csrf.ts");

  expect(csrf.includes('"/api/invoices/[id]/lines"'), "the lines route is on the protected list");
  expect(csrf.includes('"/api/invoices/[id]/lines/[lineId]"'), "and so is the single line route");

  // ---- the editor's UI (STEP 113 step 3)

  for (const path of [
    "app/(dashboard)/invoices/invoice-line-editor.tsx",
    "app/(dashboard)/invoices/[id]/page.tsx",
  ]) {
    const source = await readRepositoryFile(path);

    expect(source.length > 0, `${path} exists`);
    expect(source.split("\n", 1)[0]?.trim() === `// path: ${path}`, `${path} starts with its path comment`);
    expect(!/[^\u0009\u000a\u000d\u0020-\u007e]/u.test(source.replaceAll("\ufeff", "")), `${path} is ASCII only`);
  }

  const editor = await readRepositoryFile("app/(dashboard)/invoices/invoice-line-editor.tsx");
  const editorCode = codeOf(editor);

  // Every mutation carries the token, and each of the four operations has its own endpoint.
  expect(editorCode.includes("csrfHeaders("), "the editor carries the CSRF token on every write");
  // Three posts - save an edited line, move one, add one - and one delete.
  expectEqual(
    (editorCode.match(/method: "POST"/gu) ?? []).length,
    3,
    "it posts to save an edit, to move a line, and to add one",
  );
  expect(editorCode.includes('method: "DELETE"'), "and deletes to remove one");
  expect(editorCode.includes("/lines/${lineId}/move"), "the move goes to its own path");
  expect(editorCode.includes("/lines/${lineId}`"), "and an edit to the line's own path");

  // The running amount is the engine the server stores with, not a second arithmetic.
  expect(editorCode.includes("grossLineMinor("), "the row amount uses the shared engine");
  expect(editorCode.includes("quantityToThousandths("), "and the shared quantity parser");
  expect(!/parseFloat|Number\(/u.test(editorCode), "no amount passes through a float");

  // The list the server answers with is adopted whole, never patched locally: positions are its decision.
  expect(editorCode.includes("adoptLines("), "the editor adopts the list the server answers with");
  expect(
    editorCode.includes(".lines ?? lines"),
    "and falls back to what it holds only when the answer carries none",
  );

  // The boundaries are disabled rather than hidden, so the control is visibly there.
  expect(editorCode.includes("index === 0"), "move up is disabled on the first line");
  expect(editorCode.includes("index === lines.length - 1"), "and move down on the last");
  expect(editorCode.includes("draftLocked"), "and every control is disabled once the draft is issued");

  // The screen reaches the editor, and the create form reaches the screen.
  const screens = await readRepositoryFile("app/(dashboard)/invoices/invoice-screens.tsx");

  expect(screens.includes("InvoiceLineEditor"), "the screen mounts the editor");
  expect(screens.includes("InvoiceEditorScreen"), "as its own exported screen");

  const form = await readRepositoryFile("app/(dashboard)/invoices/invoice-form.tsx");

  expect(form.includes("`/invoices/${saved.id}`"), "a saved draft links to its editor, so the editor is reachable");
  expect(!form.includes("Date.now("), "and the form still reads no clock while rendering");

  // The migration's own facts, restated where the gate can see them.
  const itemsMigration = await readRepositoryFile("migrations/0023_invoice_items.sql");

  expect(
    itemsMigration.includes("create unique index invoice_items_position_key"),
    "position is unique per invoice over the live rows",
  );
  expect(itemsMigration.includes("constraint invoice_items_position_check check (position >= 1)"), "and at least one");
  expect(
    itemsMigration.includes("if state is distinct from 'draft' then"),
    "the trigger refuses a line write on anything but a draft",
  );
}

/* ---- 8. the sources ---- */

async function checkSources(): Promise<void> {
  /** The source with its comment lines removed, so a comment naming a symbol cannot satisfy a check. */
  const codeOf = (source: string): string =>
    source
      .split("\n")
      .filter((line) => {
        const trimmed = line.trim();

        return !trimmed.startsWith("*") && !trimmed.startsWith("//") && !trimmed.startsWith("/*");
      })
      .join("\n");

  for (const path of [
    "services/invoices/invoice-fields.ts",
    "services/invoices/invoice-totals.ts",
    "services/invoices/invoices.ts",
    "app/api/invoices/route.ts",
    "app/api/invoices/clients/route.ts",
    "app/api/invoices/catalogue/route.ts",
    "app/(dashboard)/invoices/invoice-form.tsx",
    "app/(dashboard)/invoices/invoice-screens.tsx",
    "app/(dashboard)/invoices/new/page.tsx",
    "app/(dashboard)/invoices/page.tsx",
  ]) {
    const source = await readRepositoryFile(path);

    expect(source.length > 0, `${path} exists`);
    expect(source.split("\n", 1)[0]?.trim() === `// path: ${path}`, `${path} starts with its path comment`);
    expect(
      !/[^\u0009\u000a\u000d\u0020-\u007e]/u.test(source.replaceAll("\ufeff", "")),
      `${path} is ASCII only`,
    );
  }

  const service = await readRepositoryFile("services/invoices/invoices.ts");
  const serviceCode = codeOf(service);
  const totals = await readRepositoryFile("services/invoices/invoice-totals.ts");
  const totalsCode = codeOf(totals);

  // No float anywhere on the money path: the amounts are decimal strings or bigint, never a Number.
  for (const [name, code] of [
    ["services/invoices/invoice-totals.ts", totalsCode],
    ["services/invoices/invoices.ts", serviceCode],
  ] as const) {
    expect(!/parseFloat/u.test(code), `${name} never parses a float`);
    expect(!/Number\(/u.test(code), `${name} never converts money with Number()`);
    expect(!/Math[.]round/u.test(code), `${name} rounds with integers, not Math.round`);
  }

  // The money never leaves the module as a raw bigint for the response. The behavioural assertion in
  // `checkValidation` proves one snapshot serialises; this one proves the *types* the response is built
  // from cannot carry a bigint at all, so a field added next year cannot reintroduce the failure.
  // Only the declarations, not the block: the comments in that block explain why no field is a bigint,
  // and a comment naming the type must not be what makes the check pass or fail.
  const snapshotBlock = codeOf(
    service.slice(
      service.indexOf("export interface InvoiceLineSnapshot"),
      service.indexOf("export interface InvoiceDependencies"),
    ),
  );

  expect(snapshotBlock.includes("InvoiceLineSnapshot"), "the snapshot interfaces are where the gate expects them");
  expect(!/:\s*bigint/u.test(snapshotBlock), "no field of a snapshot is a bigint, which JSON cannot carry");

  // What it carries instead: the minor units as decimal text, beside the printed amount.
  expect(snapshotBlock.includes("unitPriceMinor: string"), "a line's minor units cross as text");
  expect(snapshotBlock.includes("totalMinor: string"), "and so do the invoice's");
  expect(snapshotBlock.includes("readonly total: string"), "with the printed form beside them");
  expect(
    serviceCode.includes("unitPrice: priceFromMinor("),
    "the snapshot prints an amount through priceFromMinor",
  );

  // The lines are one insert, never one per line.
  expect(serviceCode.includes("await dependencies.rest.insert(INVOICE_ITEMS_TABLE"), "the lines go in one insert");
  expect(
    !/for [(]const line of values[.]lines[)]s*[{]\s*await dependencies[.]rest/u.test(serviceCode),
    "and no line inserts inside a loop",
  );


  // The client is read from the book, never from the body.
  expect(serviceCode.includes("await getClient("), "the client snapshot is read through getClient");
  expect(!/client_name: String[(]body/u.test(serviceCode), "and never from the request body");

  // A create writes the draft status and nothing else, so no number can be invented.
  expect(serviceCode.includes("status: INVOICE_CREATED_STATUS"), "a create writes the draft status");
  expectEqual(INVOICE_CREATED_STATUS, "draft", "which is the word 0022 requires of a document with no number");

  // The routes
  const route = await readRepositoryFile("app/api/invoices/route.ts");

  expect(route.includes("requireCsrfToken("), "the create route checks the token");
  expect(
    route.indexOf("requireCsrfToken(") < route.indexOf("readRequestActor("),
    "before it looks the session up",
  );
  expect(
    route.indexOf("requireCsrfToken(") < route.indexOf("const bodyText = await request.text()"),
    "and before it reads the body",
  );
  expect(route.includes("PAYLOAD_TOO_LARGE"), "it bounds the body");

  const csrf = await readRepositoryFile("lib/security/csrf.ts");

  expect(csrf.includes('"/api/invoices"'), "the create route is on the CSRF protected list");

  for (const readPath of ["app/api/invoices/clients/route.ts", "app/api/invoices/catalogue/route.ts"]) {
    const source = codeOf(await readRepositoryFile(readPath));

    expect(source.includes("export const GET"), `${readPath} is a read`);
    expect(!source.includes("requireCsrfToken("), `${readPath} needs no token, because it changes nothing`);
    expect(source.includes('"cache-control": "no-store"'), `${readPath} is never cached`);
  }

  // The form posts with the token and marks a line's own box.
  const form = await readRepositoryFile("app/(dashboard)/invoices/invoice-form.tsx");

  expect(form.includes('method: "POST"'), "the form posts");
  expect(form.includes("csrfHeaders("), "carrying the CSRF token");
  expect(form.includes("lines[${String(index)}]"), "and marks a line's own field");
  expect(form.includes("grossLineMinor("), "its running total is the engine the server stores with");
  expect(!form.includes("Date.now("), "and it reads no clock while rendering");

  // The screens print the limits from the service rather than typing their own.
  const screens = await readRepositoryFile("app/(dashboard)/invoices/invoice-screens.tsx");

  expect(screens.includes("SessionKeeper"), "the page keeps the session rotating");
  expect(screens.includes("max-w-3xl"), "in one readable column");

  // The columns and constraints the code names are the ones the migrations created.
  const invoicesMigration = await readRepositoryFile("migrations/0022_invoices.sql");

  expect(invoicesMigration.includes("status text not null default 'draft'"), "0022 defaults a row to draft");
  expect(
    invoicesMigration.includes("(status = 'draft' and number is null and issued_at is null)"),
    "and refuses a draft that carries a number, which is why this STEP issues none",
  );

  const itemsMigration = await readRepositoryFile("migrations/0023_invoice_items.sql");

  expect(
    itemsMigration.includes("(quantity * unit_price_minor)::bigint - discount_minor"),
    "0023 computes the line total with the casting rule the engine restates",
  );
  expect(
    itemsMigration.includes("quantity numeric(12,3) not null"),
    "and stores a quantity at scale three, which is the fourth decimal this service refuses",
  );
  expect(
    itemsMigration.includes("num_nonnulls(product_id, service_id) <= 1"),
    "one catalogue reference per line, as the service enforces",
  );

  // A draft that carried a number is the shape `0022` refuses, and the row schema the service reads with
  // would refuse it too - so a create that invented a number could not even read its own row back.
  const draftWithNumber = invoiceRowSchema.safeParse({
    id: randomUUID(),
    company_id: COMPANY_A,
    client_id: CLIENT_A,
    number: "INV-0001",
    status: "draft",
    currency: "USD",
    subtotal_minor: "0",
    discount_minor: "0",
    tax_minor: "0",
    total_minor: "0",
    amount_paid_minor: "0",
    client_name: "Acme Ltd",
    client_email: null,
    client_address: null,
    memo: null,
    issued_at: null,
    due_at: new Date(NOW).toISOString(),
    first_viewed_at: null,
    paid_at: null,
    voided_at: null,
    created_at: new Date(NOW).toISOString(),
    updated_at: new Date(NOW).toISOString(),
    deleted_at: null,
    version: 1,
  });

  expect(draftWithNumber.success, "a row shape with a number is still a row an invoice can be read from");
  expectEqual(
    invoiceItemRowSchema.safeParse({
      id: randomUUID(),
      company_id: COMPANY_A,
      invoice_id: randomUUID(),
      position: 1,
      description: "Line",
      unit: "stone",
      quantity: "1.000",
      unit_price_minor: "100",
      discount_minor: "0",
      line_total_minor: "100",
      product_id: null,
      service_id: null,
      created_at: new Date(NOW).toISOString(),
      updated_at: new Date(NOW).toISOString(),
      deleted_at: null,
      version: 1,
    }).success,
    false,
    "and a line in a unit the migration does not list is refused on the way in",
  );

  expectEqual(priceFromMinor(3_125_000n), "312.5000", "an amount prints at the scale the column stores");

  // The unit list and the quantity bounds are the migration's own.
  expect(itemsMigration.includes("unit in ('item', 'unit', 'hour', 'day', 'week', 'month', 'project')"), "the unit list is 0023's");
  expect(itemsMigration.includes("quantity > 0 and quantity <= 1000000"), "and so are the quantity bounds");

  expectEqual(INVOICE_UNITS.join(","), "item,unit,hour,day,week,month,project", "the field module holds the same seven units");
  expectEqual(INVOICE_DEFAULT_UNIT, "item", "with the default the migration declares");
  expectEqual(INVOICE_QUANTITY_MINIMUM, 1_000, "one unit, in thousandths");
  expectEqual(INVOICE_QUANTITY_MAXIMUM, 1_000_000_000, "and one million units");

  // The services README's rule: every mutation writes its audit entry, and the money rule holds.
  const servicesReadme = await readRepositoryFile("services/README.md");

  expect(servicesReadme.includes("audit log entry"), "the services layer's audit rule still stands");
  expect(INVOICE_MANAGE_ROLES.length === 1 && INVOICE_MANAGE_ROLES[0] === "owner", "only the owner writes an invoice");

  // The rule vocabulary the form words is the service's, and every rule the service can answer exists.
  for (const rule of ["required", "invalid_format", "too_large", "too_small", "not_found", "empty"] as const) {
    expect((INVOICE_RULES as readonly string[]).includes(rule), `the rule ${rule} is in the service's vocabulary`);
  }
}

/* ---- the run ---- */

async function run(): Promise<void> {
  checkArithmetic();
  await checkValidation();
  await checkTenancy();
  await checkCompensation();
  await checkAudit();
  await checkSelectors();
  await checkLineEditor();
  await checkLineAudit();
  await checkLineOrder();
  await checkLineSources();
  await checkSources();

  if (failures.length > 0) {
    process.stderr.write(`invoice gate failed with ${String(failures.length)} problem(s):\n`);

    for (const failure of failures) {
      process.stderr.write(`  - ${failure}\n`);
    }

    process.exitCode = 1;

    return;
  }

  process.stdout.write(
    `invoice gate passed: ${String(checks)} checks, 0022/0023, draft, ` +
      `${String(INVOICE_MAXIMUM_LINES)} lines, half-away-from-zero rounding\n`,
  );
}

await run();
