// path: services/products/verify.ts
import process from "node:process";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { z } from "zod";
import { createInMemoryAuditTrail, type AuditTrail } from "../../lib/auth/audit.ts";
import type { RestClient } from "../../lib/auth/rest.ts";
import type { PlatformRole, RequestActor } from "../../lib/auth/types.ts";
import { AppError, isAppError } from "../../lib/errors/app-error.ts";
import {
  CATALOGUE_CREATED_AUDIT_ACTION,
  CATALOGUE_DELETED_AUDIT_ACTION,
  CATALOGUE_MANAGE_ROLES,
  CATALOGUE_RULES,
  CATALOGUE_UPDATED_AUDIT_ACTION,
  catalogueRowSchema,
  createCatalogueEntry,
  deleteCatalogueEntry,
  getCatalogueEntry,
  updateCatalogueEntry,
  type CatalogueDependencies,
  type CatalogueSnapshot,
} from "./catalogue.ts";
import {
  CATALOGUE_LIST_MAXIMUM_OFFSET,
  CATALOGUE_LIST_PAGE_SIZE,
  CATALOGUE_LIST_ORDER,
  CATALOGUE_SEARCH_MAXIMUM_LENGTH,
  catalogueListColumnsOf,
  catalogueListQueryOf,
  catalogueListRowSchema,
  listCatalogueEntries,
  parseCatalogueListQuery,
} from "./catalogue-list.ts";
import {
  CATALOGUE_IMPORT_MAXIMUM_ROWS,
  importCatalogueEntries,
} from "./catalogue-import.ts";
import {
  CATALOGUE_CODE_COLUMN,
  CATALOGUE_CURRENCIES,
  CATALOGUE_DEFAULT_UNIT,
  CATALOGUE_FIELD_LIMITS,
  CATALOGUE_TABLES,
  CATALOGUE_UNITS,
  CATALOGUE_KINDS,
  type CatalogueKind,
} from "./catalogue-fields.ts";
import { priceFromMinor, priceProblemOf, priceToMinor, PRICE_MAXIMUM_MINOR } from "./price.ts";

/**
 * Catalogue gate for STEP 108. Run with `node services/products/verify.ts`.
 *
 * The gate drives the real service over an in-memory PostgREST of `0020` and `0021`, so what passes
 * here is the code the routes run:
 *
 *   1. the money: typed major units become whole minor units by decimal string arithmetic, the
 *      ceiling and the pattern are enforced, and the value round trips back to what the form shows;
 *   2. the validation: every ceiling, the unit vocabulary, the code shape and the unknown key rule,
 *      with one `{field, rule}` detail per broken field and the code reported under the name the form
 *      uses (`sku` for a product, `code` for a service);
 *   3. the tenancy: the company comes from the session, every query is scoped to it, a foreign row is
 *      a 404, a deleted row is a 404, and only the owner role may act;
 *   4. the uniqueness: a code already used by the same merchant answers CONFLICT naming the field, and
 *      another merchant may use the same code;
 *   5. the audit: `product.created` / `service.created` and their `.updated` siblings, naming the row,
 *      the company and the actor, and never carrying the description;
 *   6. the sources: the four routes are token-checked and on the protected list, the tables and
 *      columns the code names are the ones the migrations created, and the catalog carries every key
 *      the screens use.
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

/* ---- an in-memory products and services catalogue shaped like 0020 and 0021 ---- */

interface CatalogueDb {
  readonly rows: Record<CatalogueKind, Array<Record<string, unknown>>>;
  inserts: Array<{ readonly table: string; readonly row: Record<string, unknown> }>;
  updates: Array<{ readonly table: string; readonly query: string; readonly values: Record<string, unknown> }>;
  queries: string[];
}

function createDb(): CatalogueDb {
  return { rows: { product: [], service: [] }, inserts: [], updates: [], queries: [] };
}

function queryParts(query: string): Map<string, string> {
  const parts = new Map<string, string>();

  for (const piece of query.split("&")) {
    const index = piece.indexOf("=");

    if (index > 0) {
      parts.set(piece.slice(0, index), piece.slice(index + 1));
    }
  }

  return parts;
}

/** PostgREST answers a `bigint` as a number or a decimal string, never as a bigint; the fixture does the same. */
function wireOf(row: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const wire: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(row)) {
    wire[key] = typeof value === "bigint" ? value.toString() : value;
  }

  return wire;
}

function kindOfTable(table: string): CatalogueKind {
  const entry = CATALOGUE_KINDS.find((kind) => CATALOGUE_TABLES[kind] === table);

  if (entry === undefined) {
    throw new Error(`the catalogue service touches no table but products and services: ${table}`);
  }

  return entry;
}

function createCatalogueRest(db: CatalogueDb): RestClient {
  return {
    select<TRow>(table: string, query: string, schema: z.ZodType<TRow>): Promise<readonly TRow[]> {
      db.queries.push(`${table}?${query}`);

      const kind = kindOfTable(table);
      const parts = queryParts(query);
      const company = parts.get("company_id");

      if (company === undefined || !company.startsWith("eq.")) {
        return Promise.reject(new Error(`a catalogue read is not scoped to one company: ${query}`));
      }

      const companyId = company.slice(3);
      const id = parts.get("id");
      const liveOnly = parts.get("deleted_at") === "is.null";
      let matched = db.rows[kind].filter((row) => row["company_id"] === companyId);

      if (id !== undefined && id.startsWith("eq.")) {
        matched = matched.filter((row) => row["id"] === id.slice(3));
      }

      if (liveOnly) {
        matched = matched.filter((row) => row["deleted_at"] === null);
      }

      // `or=(name.ilike.*term*,...)`: a substring match against each named column, case insensitively,
      // which is what PostgREST's `ilike` with `*` on both sides asks the database for.
      const or = parts.get("or");

      if (or !== undefined) {
        const body = or.replace(/^\(/u, "").replace(/\)$/u, "").replace(/%2C/gu, ",");
        const clauses = body.split(",").map((clause) => {
          const [column = "", operator = "", ...rest] = clause.split(".");
          const pattern = decodeURIComponent(rest.join(".")).replace(/^\*/u, "").replace(/\*$/u, "");

          return { column, operator, needle: pattern.toLowerCase() };
        });

        matched = matched.filter((row) =>
          clauses.some((clause) => {
            if (clause.operator !== "ilike") {
              throw new Error(`the catalogue list searched with an operator the gate does not model: ${clause.operator}`);
            }

            const value = row[clause.column];

            return typeof value === "string" && value.toLowerCase().includes(clause.needle);
          }),
        );
      }

      // `order=created_at.desc,id.desc`: the order the page index stores.
      const order = parts.get("order");

      if (order !== undefined) {
        const keys = order.split(",").map((spec) => {
          const [column = "", direction = "asc"] = spec.split(".");

          return { column, descending: direction === "desc" };
        });

        matched = [...matched].sort((left, right) => {
          for (const key of keys) {
            const a = String(left[key.column] ?? "");
            const b = String(right[key.column] ?? "");
            const comparison = a < b ? -1 : a > b ? 1 : 0;

            if (comparison !== 0) {
              return key.descending ? -comparison : comparison;
            }
          }

          return 0;
        });
      }

      const offset = parts.get("offset");
      const limit = parts.get("limit");

      if (offset !== undefined) {
        matched = matched.slice(Number.parseInt(offset, 10));
      }

      if (limit !== undefined) {
        matched = matched.slice(0, Number.parseInt(limit, 10));
      }

      // `select=a,b,code:sku` - the alias is the one thing the projection has to model, because the
      // list reads a product's `sku` under the name `code` so one row shape covers both tables.
      const selection = parts.get("select");
      const projected =
        selection === undefined
          ? matched
          : matched.map((row) => {
              const values: Record<string, unknown> = {};

              for (const spec of selection.split(",")) {
                const [alias = "", source] = spec.includes(":") ? spec.split(":") : [spec, spec];

                values[alias] = row[source ?? alias] ?? null;
              }

              return values;
            });

      return Promise.resolve(projected.map((row) => schema.parse(row)));
    },
    insert(): Promise<never> {
      return Promise.reject(new Error("the catalogue service inserts with return=representation only"));
    },
    insertReturning<TRow>(
      table: string,
      rows: readonly Readonly<Record<string, unknown>>[],
      schema: z.ZodType<TRow>,
    ): Promise<readonly TRow[]> {
      const kind = kindOfTable(table);

      for (const row of rows) {
        db.inserts.push({ table, row: { ...row } });

        const codeColumn = CATALOGUE_CODE_COLUMN[kind];
        const code = row[codeColumn];
        const codeText = typeof code === "string" ? code.toLowerCase() : null;

        // products_sku_key / services_code_key: unique per merchant under lower(), live rows only.
        if (
          codeText !== null &&
          db.rows[kind].some(
            (existing) =>
              existing["company_id"] === row["company_id"] &&
              existing["deleted_at"] === null &&
              typeof existing[codeColumn] === "string" &&
              existing[codeColumn].toLowerCase() === codeText,
          )
        ) {
          return Promise.reject(new AppError("CONFLICT", { cause: { code: "23505" } }));
        }

        const createdAt = new Date(NOW + db.rows[kind].length).toISOString();
        const stored: Record<string, unknown> = {
          id: randomUUID(),
          deleted_at: null,
          version: 1,
          created_at: createdAt,
          updated_at: createdAt,
          sku: null,
          code: null,
          ...wireOf(row),
        };

        db.rows[kind].push(stored);

        return Promise.resolve([schema.parse(stored)]);
      }

      return Promise.reject(new Error("insertReturning needs one row"));
    },
    update(table: string, query: string, values: Readonly<Record<string, unknown>>): Promise<void> {
      db.updates.push({ table, query, values: { ...values } });

      const kind = kindOfTable(table);
      const parts = queryParts(query);
      const company = parts.get("company_id");
      const id = parts.get("id");

      if (company === undefined || !company.startsWith("eq.") || id === undefined || !id.startsWith("eq.")) {
        return Promise.reject(new Error(`a catalogue update is not scoped to one row of one company: ${query}`));
      }

      const row = db.rows[kind].find(
        (candidate) =>
          candidate["id"] === id.slice(3) &&
          candidate["company_id"] === company.slice(3) &&
          (parts.get("deleted_at") !== "is.null" || candidate["deleted_at"] === null),
      );

      // The partial unique indexes apply to an update exactly as to an insert.
      const codeColumn = CATALOGUE_CODE_COLUMN[kind];
      const nextCode = values[codeColumn];

      if (typeof nextCode === "string") {
        const clash = db.rows[kind].some(
          (candidate) =>
            candidate !== row &&
            candidate["company_id"] === company.slice(3) &&
            candidate["deleted_at"] === null &&
            typeof candidate[codeColumn] === "string" &&
            candidate[codeColumn].toLowerCase() === nextCode.toLowerCase(),
        );

        if (clash) {
          return Promise.reject(new AppError("CONFLICT", { cause: { code: "23505" } }));
        }
      }

      // PostgREST reports success when nothing matched; the service re-reads for that reason.
      if (row !== undefined) {
        Object.assign(row, wireOf(values), {
          updated_at: new Date(NOW + db.rows[kind].length + 1_000).toISOString(),
          version: Number(row["version"]) + 1,
        });
      }

      return Promise.resolve();
    },
    rpc(): Promise<never> {
      return Promise.reject(new Error("the catalogue service calls no rpc"));
    },
  };
}

function depsOf(db: CatalogueDb, audit: AuditTrail = createInMemoryAuditTrail()): CatalogueDependencies {
  return { rest: createCatalogueRest(db), audit, now: () => NOW };
}

async function rejectionOf(action: () => Promise<unknown>): Promise<unknown> {
  try {
    await action();
  } catch (error) {
    return error;
  }

  return null;
}

function detailsOf(error: unknown): ReadonlyArray<{ readonly field?: unknown; readonly rule?: unknown }> {
  return isAppError(error) ? error.details : [];
}

/* ---- fixtures ---- */

const PRODUCT_BODY = {
  name: "Desk lamp",
  sku: "LAMP-01",
  description: "Adjustable arm, warm white.",
  unit_price: "42.50",
  currency: "USD",
  unit: "item",
};

const SERVICE_BODY = {
  name: "Consulting hour",
  code: "CONSULT-1",
  description: "Advisory work billed by the hour.",
  unit_price: "125",
  currency: "USD",
  unit: "hour",
};

/* ---- the money ---- */

function checkPrice(): void {
  expectEqual(priceToMinor("12.50"), 125_000n, "12.50 is 125000 minor units");
  expectEqual(priceToMinor("125"), 1_250_000n, "a whole amount carries no fraction");
  expectEqual(priceToMinor("0"), 0n, "zero is a price, which 0020 allows");
  expectEqual(priceToMinor("0.0001"), 1n, "the fourth place is the smallest amount");
  expectEqual(priceToMinor(" 7.25 "), 72_500n, "surrounding space is trimmed, not rejected");
  expectEqual(priceToMinor("999999999999.9999"), null, "a price beyond the ceiling is refused, not wrapped");

  for (const hostile of ["", "abc", "12,50", "1e3", "-5", "12.50555", "12.5.5", "$12", "12 50", "   ", "NaN", "Infinity", "1234567890123"]) {
    expectEqual(priceToMinor(hostile), null, `the price ${JSON.stringify(hostile)} is refused`);
  }

  expectEqual(priceToMinor("12.505"), 125_050n, "a third decimal is a price at this scale");
  expectEqual(priceProblemOf("12.50555"), "invalid_format", "a fifth decimal is a format problem");
  expectEqual(priceProblemOf("999999999999.9999"), "too_large", "a price past the ceiling is too large");
  expectEqual(priceProblemOf("1234567890123"), "invalid_format", "a whole number of more than twelve digits is refused");
  expectEqual(priceToMinor("999999999999.9999"), null, "and the ceiling is not stored");
  expectEqual(priceProblemOf("99.9999"), null, "a price under the ceiling is a price");
  expectEqual(priceProblemOf("12.50"), null, "a good price has no problem");
  expectEqual(priceToMinor("1000000000000"), null, "the ceiling itself is refused, not stored");
  expectEqual(PRICE_MAXIMUM_MINOR, 1_000_000_000_000n, "the ceiling is the one the module states");

  // the round trip is exact, which is what lets the form print what was stored
  for (const text of ["0.0001", "12.5000", "42.5000", "999999.9999"]) {
    expectEqual(priceFromMinor(priceToMinor(text) ?? 0n), text, `the price ${text} prints back as itself`);
  }

  expectEqual(priceFromMinor(1n), "0.0001", "one minor unit prints as one ten thousandth");
  expectEqual(priceFromMinor(1_250_000n), "125.0000", "a whole amount prints four places");
}

/* ---- the create ---- */

async function checkCreate(kind: CatalogueKind): Promise<void> {
  const db = createDb();
  const audit = createInMemoryAuditTrail();
  const dependencies = depsOf(db, audit);
  const body = kind === "product" ? PRODUCT_BODY : SERVICE_BODY;
  const created = await createCatalogueEntry({ actor: owner, kind, body }, dependencies);

  expectEqual(created.kind, kind, `${kind}: the snapshot names its catalogue`);
  expectEqual(created.companyId, COMPANY_A, `${kind}: scoped to the actor's company`);
  expectEqual(created.values.name, body.name, `${kind}: the name`);
  expectEqual(created.values.code, kind === "product" ? "LAMP-01" : "CONSULT-1", `${kind}: the code`);
  expectEqual(created.values.unitPriceMinor, kind === "product" ? 425_000n : 1_250_000n, `${kind}: the price in minor units`);
  expectEqual(created.values.unitPrice, kind === "product" ? "42.5000" : "125.0000", `${kind}: and the printed price`);
  expectEqual(created.values.currency, "USD", `${kind}: USD`);
  expectEqual(created.values.unit, kind === "product" ? "item" : "hour", `${kind}: the unit`);
  expectEqual(db.inserts.length, 1, `${kind}: one row inserted`);
  expectEqual(at(db.inserts, 0, `${kind} insert`).table, CATALOGUE_TABLES[kind], `${kind}: into its own table`);
  expectEqual(at(db.inserts, 0, `${kind} insert`).row["company_id"], COMPANY_A, `${kind}: with the session's company`);
  expect(
    typeof at(db.inserts, 0, `${kind} insert`).row["unit_price_minor"] === "bigint",
    `${kind}: the price is written as a bigint, never a float`,
  );

  const entry = at(audit.entries, 0, `${kind} audit`);
  expectEqual(entry.action, CATALOGUE_CREATED_AUDIT_ACTION[kind], `${kind}: audited as the create action`);
  expectEqual(entry.entityType, kind, `${kind}: against its own entity`);
  expectEqual(entry.entityId, created.id, `${kind}: naming the row`);
  expectEqual(entry.companyId, COMPANY_A, `${kind}: and the company`);
  expectEqual(entry.actorUserId, OWNER_ID, `${kind}: and the actor`);
  expect(
    !JSON.stringify(entry.payload).includes("Adjustable arm") &&
      !JSON.stringify(entry.payload).includes("Advisory work"),
    `${kind}: the description never reaches the audit trail`,
  );
}

async function checkValidation(): Promise<void> {
  const db = createDb();
  const dependencies = depsOf(db);

  async function refusal(kind: CatalogueKind, body: unknown): Promise<unknown> {
    return rejectionOf(() => createCatalogueEntry({ actor: owner, kind, body }, dependencies));
  }

  const codeField = CATALOGUE_CODE_COLUMN.product;

  const cases: Array<[CatalogueKind, string, unknown, string, string]> = [
    ["product", "an empty name", { ...PRODUCT_BODY, name: "   " }, "name", "required"],
    ["product", "a long name", { ...PRODUCT_BODY, name: "x".repeat(161) }, "name", "too_long"],
    ["product", "a long description", { ...PRODUCT_BODY, description: "x".repeat(2_001) }, "description", "too_long"],
    ["product", "a malformed price", { ...PRODUCT_BODY, unit_price: "12,50" }, "unit_price", "invalid_format"],
    ["product", "a negative price", { ...PRODUCT_BODY, unit_price: "-5" }, "unit_price", "invalid_format"],
    ["product", "a price with five places", { ...PRODUCT_BODY, unit_price: "1.23456" }, "unit_price", "invalid_format"],
    ["product", "a price past the ceiling", { ...PRODUCT_BODY, unit_price: "999999999999.9999" }, "unit_price", "too_large"],
    ["product", "an empty price", { ...PRODUCT_BODY, unit_price: "  " }, "unit_price", "required"],
    ["product", "a unit outside the list", { ...PRODUCT_BODY, unit: "stone" }, "unit", "invalid_format"],
    ["product", "a currency the platform cannot charge", { ...PRODUCT_BODY, currency: "EUR" }, "currency", "invalid_format"],
    ["product", "a long code", { ...PRODUCT_BODY, sku: `A${"x".repeat(48)}` }, "sku", "too_long"],
    ["product", "a code with a space", { ...PRODUCT_BODY, sku: "LA MP" }, "sku", "invalid_format"],
    ["product", "a code starting with a hyphen", { ...PRODUCT_BODY, sku: "-LAMP" }, "sku", "invalid_format"],
    ["product", "an unknown key", { ...PRODUCT_BODY, colour: "red" }, "colour", "unknown_field"],
    ["service", "a service named with no name", { ...SERVICE_BODY, name: "" }, "name", "required"],
    ["service", "a malformed service code", { ...SERVICE_BODY, code: "CON SULT" }, "code", "invalid_format"],
    ["service", "a service unit outside the list", { ...SERVICE_BODY, unit: "minute" }, "unit", "invalid_format"],
    ["service", "a service price that is not a price", { ...SERVICE_BODY, unit_price: "free" }, "unit_price", "invalid_format"],
  ];

  for (const [kind, description, body, field, rule] of cases) {
    const error = await refusal(kind, body);
    expect(isAppError(error) && error.code === "VALIDATION_FAILED", `${kind}: ${description} is a validation failure`);
    expectDeepEqual(detailsOf(error), [{ field, rule }], `${kind}: ${description} names ${field} with ${rule}`);
  }

  expectEqual(db.inserts.length, 0, "no refused create wrote a row");

  // the code is reported under the name the form uses, in each catalogue
  const productCode = await refusal("product", { ...PRODUCT_BODY, sku: "a b" });
  expectDeepEqual(detailsOf(productCode), [{ field: "sku", rule: "invalid_format" }], "a product code is reported as sku");
  const serviceCode = await refusal("service", { ...SERVICE_BODY, code: "a b" });
  expectDeepEqual(detailsOf(serviceCode), [{ field: "code", rule: "invalid_format" }], "a service code is reported as code");

  // every broken field at once, so the form marks them together
  const many = await refusal("product", { name: "", sku: "LA MP", description: "d", unit_price: "x", unit: "stone", currency: "EUR" });
  expectDeepEqual(
    detailsOf(many).map((detail) => detail.field),
    ["name", "sku", "unit_price", "unit", "currency"],
    "every broken field is listed in one answer, in the order the form reads",
  );

  // a price past the ceiling and a malformed code are reported together, not one at a time
  const twoKinds = await refusal("product", { ...PRODUCT_BODY, sku: "LA MP", unit_price: "999999999999.9999" });
  expectDeepEqual(
    detailsOf(twoKinds),
    [
      { field: "sku", rule: "invalid_format" },
      { field: "unit_price", rule: "too_large" },
    ],
    "the code and the price are judged in one answer",
  );

  const notObject = await refusal("product", "a string");
  expect(isAppError(notObject) && notObject.code === "VALIDATION_FAILED", "a non-object body is a validation failure");
  expectDeepEqual(detailsOf(notObject), [{ field: "product", rule: "invalid_format" }], "and names the catalogue it was posting to");

  // an empty code is "no code", which both tables allow
  const noCode = await createCatalogueEntry(
    { actor: owner, kind: "product", body: { ...PRODUCT_BODY, sku: "" } },
    depsOf(db),
  );
  expectEqual(noCode.values.code, null, "an empty code is stored as null");

  // control characters never reach the row
  const cleaned = await createCatalogueEntry(
    { actor: owner, kind: "product", body: { ...PRODUCT_BODY, name: "De\u0007sk lamp", sku: "LAMP-02" } },
    depsOf(db),
  );
  expectEqual(cleaned.values.name, "Desk lamp", "the sanitiser removed the control character");

  expectEqual(codeField, CATALOGUE_CODE_COLUMN.product, "the product code column is sku");
}

/* ---- uniqueness and tenancy ---- */

async function checkUniqueness(kind: CatalogueKind): Promise<void> {
  const db = createDb();
  const dependencies = depsOf(db);
  const body = kind === "product" ? PRODUCT_BODY : SERVICE_BODY;

  await createCatalogueEntry({ actor: owner, kind, body }, dependencies);

  const codeColumn = CATALOGUE_CODE_COLUMN[kind];
  const sameCode = String((body as Record<string, string>)[codeColumn]);
  const duplicate = await rejectionOf(() =>
    createCatalogueEntry({ actor: owner, kind, body: { ...body, name: "Another" } }, dependencies),
  );
  expect(isAppError(duplicate) && duplicate.code === "CONFLICT", `${kind}: a duplicate code answers CONFLICT`);
  expectDeepEqual(
    detailsOf(duplicate),
    [{ field: codeColumn, rule: "already_used" }],
    `${kind}: naming the code field`,
  );

  const upperCase = await rejectionOf(() =>
    createCatalogueEntry(
      { actor: owner, kind, body: { ...body, [codeColumn]: sameCode.toUpperCase(), name: "Third" } },
      dependencies,
    ),
  );
  expect(isAppError(upperCase) && upperCase.code === "CONFLICT", `${kind}: the code is unique case insensitively`);

  // another merchant may hold the same code
  const other = await createCatalogueEntry({ actor: otherOwner, kind, body }, depsOf(db));
  expectEqual(other.companyId, COMPANY_B, `${kind}: another merchant can use the same code`);

  // the same merchant may hold the code again once the row is soft deleted
  const live = at(db.rows[kind], 0, `${kind} first row`);
  live["deleted_at"] = new Date(NOW).toISOString();
  const reused = await createCatalogueEntry({ actor: owner, kind, body }, depsOf(db));
  expectEqual(reused.values.code, sameCode, `${kind}: a deleted row releases its code`);
}

async function checkTenancy(kind: CatalogueKind): Promise<void> {
  const db = createDb();
  const dependencies = depsOf(db);
  const body = kind === "product" ? PRODUCT_BODY : SERVICE_BODY;
  const created = await createCatalogueEntry({ actor: owner, kind, body }, dependencies);

  const read = await getCatalogueEntry({ actor: owner, kind, entryId: created.id }, dependencies);
  expectEqual(read.id, created.id, `${kind}: the owner reads the entry`);
  expect(
    db.queries.every((query) => query.includes(`company_id=eq.${COMPANY_A}`)),
    `${kind}: every query is company scoped`,
  );

  const foreign = await rejectionOf(() =>
    getCatalogueEntry({ actor: otherOwner, kind, entryId: created.id }, dependencies),
  );
  expect(isAppError(foreign) && foreign.code === "RESOURCE_NOT_FOUND", `${kind}: another merchant gets a 404`);

  const missing = await rejectionOf(() =>
    getCatalogueEntry({ actor: owner, kind, entryId: randomUUID() }, dependencies),
  );
  expect(isAppError(missing) && missing.code === "RESOURCE_NOT_FOUND", `${kind}: an unknown id is a 404`);

  const badId = await rejectionOf(() =>
    getCatalogueEntry({ actor: owner, kind, entryId: "not-a-uuid" }, dependencies),
  );
  expect(isAppError(badId) && badId.code === "VALIDATION_FAILED", `${kind}: a malformed id is a 422`);

  for (const roles of [["compliance_kyc"], ["support"], ["finance_ops"], ["ceo"], ["super_admin"], ["blogger"]] as const) {
    const refused = await rejectionOf(() =>
      getCatalogueEntry(
        { actor: actorOf([...roles], COMPANY_A, { userId: OFFICE_ID }), kind, entryId: created.id },
        dependencies,
      ),
    );
    expect(isAppError(refused) && refused.code === "PERMISSION_DENIED", `${kind}: the role ${roles[0]} may not read the catalogue`);
  }

  const platformAccount = await rejectionOf(() =>
    getCatalogueEntry({ actor: desk, kind, entryId: created.id }, dependencies),
  );
  expect(
    isAppError(platformAccount) && platformAccount.code === "PERMISSION_DENIED",
    `${kind}: a platform account with no company is refused`,
  );

  // a soft deleted row is not live
  at(db.rows[kind], 0, `${kind} seeded row`)["deleted_at"] = new Date(NOW).toISOString();
  const deleted = await rejectionOf(() =>
    getCatalogueEntry({ actor: owner, kind, entryId: created.id }, dependencies),
  );
  expect(isAppError(deleted) && deleted.code === "RESOURCE_NOT_FOUND", `${kind}: a deleted row is a 404`);

  // the two catalogues do not read each other's rows
  const wrongCatalogue = await rejectionOf(() =>
    getCatalogueEntry({ actor: owner, kind: kind === "product" ? "service" : "product", entryId: created.id }, dependencies),
  );
  expect(
    isAppError(wrongCatalogue) && wrongCatalogue.code === "RESOURCE_NOT_FOUND",
    `${kind}: the other catalogue does not hold this row`,
  );
}

/* ---- the edit ---- */

async function checkUpdate(kind: CatalogueKind): Promise<void> {
  const db = createDb();
  const audit = createInMemoryAuditTrail();
  const dependencies = depsOf(db, audit);
  const body = kind === "product" ? PRODUCT_BODY : SERVICE_BODY;
  const created = await createCatalogueEntry({ actor: owner, kind, body }, dependencies);
  const codeColumn = CATALOGUE_CODE_COLUMN[kind];

  const updatesBefore = db.updates.length;
  const updated = await updateCatalogueEntry(
    { actor: owner, kind, entryId: created.id, body: { unit_price: "50", unit: "day" } },
    dependencies,
  );

  expectEqual(updated.values.unitPrice, "50.0000", `${kind}: the price changed`);
  expectEqual(updated.values.unitPriceMinor, 500_000n, `${kind}: and is stored in minor units`);
  expectEqual(updated.values.unit, "day", `${kind}: the unit changed`);
  expectEqual(updated.values.name, body.name, `${kind}: an unsent field keeps its value`);
  expectEqual(updated.values.code, created.values.code, `${kind}: and so does the code`);
  expectEqual(db.updates.length, updatesBefore + 1, `${kind}: one update ran`);

  const lastUpdate = at(db.updates, db.updates.length - 1, `${kind} last update`);
  expectEqual(lastUpdate.table, CATALOGUE_TABLES[kind], `${kind}: into its own table`);
  expect(
    lastUpdate.query.includes(`company_id=eq.${COMPANY_A}`) && lastUpdate.query.includes("deleted_at=is.null"),
    `${kind}: scoped to one live row of the actor's company`,
  );
  expectDeepEqual(Object.keys(lastUpdate.values).sort(), ["unit", "unit_price_minor"], `${kind}: only the sent fields were written`);

  const lastAudit = at(audit.entries, audit.entries.length - 1, `${kind} last audit`);
  expectEqual(lastAudit.action, CATALOGUE_UPDATED_AUDIT_ACTION[kind], `${kind}: audited as the update action`);
  expectDeepEqual(
    (lastAudit.payload as { fields: string[] }).fields.sort(),
    ["unit", "unit_price"],
    `${kind}: naming the changed fields`,
  );

  // an empty code clears the column
  const cleared = await updateCatalogueEntry(
    { actor: owner, kind, entryId: created.id, body: { [codeColumn]: "" } },
    dependencies,
  );
  expectEqual(cleared.values.code, null, `${kind}: a cleared code is stored as null`);

  // the price is re-validated on an edit exactly as on a create
  const badPrice = await rejectionOf(() =>
    updateCatalogueEntry({ actor: owner, kind, entryId: created.id, body: { unit_price: "1.23456" } }, dependencies),
  );
  expect(isAppError(badPrice) && badPrice.code === "VALIDATION_FAILED", `${kind}: a malformed price is refused on an edit`);

  const badUnit = await rejectionOf(() =>
    updateCatalogueEntry({ actor: owner, kind, entryId: created.id, body: { unit: "stone" } }, dependencies),
  );
  expect(isAppError(badUnit) && badUnit.code === "VALIDATION_FAILED", `${kind}: a unit outside the list is refused on an edit`);

  const unknown = await rejectionOf(() =>
    updateCatalogueEntry({ actor: owner, kind, entryId: created.id, body: { colour: "red" } }, dependencies),
  );
  expect(isAppError(unknown) && unknown.code === "VALIDATION_FAILED", `${kind}: an unknown key is refused on an edit`);

  // a duplicate code on an edit is a conflict naming the field
  await createCatalogueEntry({ actor: owner, kind, body: { ...body, [codeColumn]: "TAKEN-1" } }, dependencies);
  const conflict = await rejectionOf(() =>
    updateCatalogueEntry({ actor: owner, kind, entryId: created.id, body: { [codeColumn]: "taken-1" } }, dependencies),
  );
  expect(isAppError(conflict) && conflict.code === "CONFLICT", `${kind}: a duplicate code on an edit answers CONFLICT`);
  expectDeepEqual(detailsOf(conflict), [{ field: codeColumn, rule: "already_used" }], `${kind}: naming the code field`);

  // another merchant's row is a 404, and the row is untouched
  const foreign = await rejectionOf(() =>
    updateCatalogueEntry({ actor: otherOwner, kind, entryId: created.id, body: { name: "Nope" } }, dependencies),
  );
  expect(isAppError(foreign) && foreign.code === "RESOURCE_NOT_FOUND", `${kind}: a foreign edit is a 404`);
  const stillThere = await getCatalogueEntry({ actor: owner, kind, entryId: created.id }, dependencies);
  expectEqual(stillThere.values.name, body.name, `${kind}: and the name is unchanged`);

  // a non-owner may not edit
  const roleDenied = await rejectionOf(() =>
    updateCatalogueEntry(
      { actor: actorOf(["finance_ops"], COMPANY_A, { userId: OFFICE_ID }), kind, entryId: created.id, body: { name: "Nope" } },
      dependencies,
    ),
  );
  expect(isAppError(roleDenied) && roleDenied.code === "PERMISSION_DENIED", `${kind}: a non-owner role may not edit`);
}

/* ---- STEP 109: the paginated list and the search ---- */

/** Seed one catalogue with `count` entries whose names, codes and timestamps are distinct and ordered. */
async function seed(
  db: CatalogueDb,
  kind: CatalogueKind,
  companyActor: RequestActor,
  count: number,
  prefix: string,
): Promise<readonly CatalogueSnapshot[]> {
  const created: CatalogueSnapshot[] = [];

  for (let index = 0; index < count; index += 1) {
    const codeColumn = CATALOGUE_CODE_COLUMN[kind];
    const body =
      kind === "product"
        ? {
            name: `${prefix} lamp ${String(index).padStart(2, "0")}`,
            sku: `${prefix.toUpperCase()}-${String(index).padStart(2, "0")}`,
            description: index % 2 === 0 ? "with a warm white bulb" : null,
            unit_price: `${String(index + 1)}.50`,
            currency: "USD",
            unit: "item",
          }
        : {
            name: `${prefix} hour ${String(index).padStart(2, "0")}`,
            code: `${prefix.toUpperCase()}-${String(index).padStart(2, "0")}`,
            description: index % 2 === 0 ? "advisory work" : null,
            unit_price: `${String(index + 1)}.25`,
            currency: "USD",
            unit: "hour",
          };

    expect(
      typeof (body as Record<string, unknown>)[codeColumn] === "string",
      `${kind}: the seed names a code`,
    );

    created.push(await createCatalogueEntry({ actor: companyActor, kind, body }, depsOf(db)));
  }

  return created;
}

/** The ids of one page, in the order it printed them. */
function idsOf(page: { readonly entries: readonly { readonly id: string }[] }): readonly string[] {
  return page.entries.map((entry) => entry.id);
}

async function checkList(kind: CatalogueKind): Promise<void> {
  const db = createDb();
  const dependencies = depsOf(db);
  const created = await seed(db, kind, owner, 30, "bench");

  const first = await listCatalogueEntries(
    { actor: owner, kind, query: parseCatalogueListQuery({}) },
    dependencies,
  );

  expectEqual(first.kind, kind, `${kind}: the page names its catalogue`);
  expectEqual(first.entries.length, CATALOGUE_LIST_PAGE_SIZE, `${kind}: a full page is one page size`);
  expectEqual(first.pageSize, CATALOGUE_LIST_PAGE_SIZE, `${kind}: and says so`);
  expectEqual(first.offset, 0, `${kind}: the first page starts at the newest row`);
  expectEqual(first.pageNumber, 1, `${kind}: and is page one`);
  expectEqual(first.previousOffset, null, `${kind}: with nothing newer to go back to`);
  expectEqual(first.nextOffset, CATALOGUE_LIST_PAGE_SIZE, `${kind}: and a next page to go on to`);

  // newest first, which is the order products_page_idx / services_page_idx stores
  const newestFirst = [...created].reverse().map((entry) => entry.id);

  expectDeepEqual(idsOf(first), newestFirst.slice(0, CATALOGUE_LIST_PAGE_SIZE), `${kind}: the page is newest first`);

  const second = await listCatalogueEntries(
    { actor: owner, kind, query: parseCatalogueListQuery({ offset: String(CATALOGUE_LIST_PAGE_SIZE) }) },
    dependencies,
  );

  expectEqual(second.offset, CATALOGUE_LIST_PAGE_SIZE, `${kind}: the second page starts where the first ended`);
  expectEqual(second.pageNumber, 2, `${kind}: and is page two`);
  expectEqual(second.previousOffset, 0, `${kind}: with a newer page behind it`);
  expectEqual(second.nextOffset, null, `${kind}: and nothing after the last row`);
  expectEqual(second.entries.length, 30 - CATALOGUE_LIST_PAGE_SIZE, `${kind}: the short page is the last one`);

  // the two pages do not overlap and together are the whole catalogue
  const seen = new Set([...idsOf(first), ...idsOf(second)]);

  expectEqual(seen.size, 30, `${kind}: two pages cover every entry exactly once`);

  // the price is printed by the one function allowed to format an amount
  const priced = at(first.entries, 0, `${kind} first row`);

  expect(/^\d+[.]\d{4}$/u.test(priced.unitPrice), `${kind}: the price prints exactly four decimals`);
  expectEqual(priceToMinor(priced.unitPrice), priced.unitPriceMinor, `${kind}: and prints back to the amount it was read from`);
  expectEqual(priced.currency, "USD", `${kind}: and its currency`);
  expectEqual(typeof priced.unitPriceMinor, "bigint", `${kind}: the minor units stay a bigint`);

  // the code column is the kind's own, read under one name
  expect(priced.code !== null, `${kind}: the code is on the row`);
  expect(priced.code !== null && priced.code.startsWith("BENCH-"), `${kind}: and is the code that was written`);

  // a page past the end is empty rather than an error
  const beyond = await listCatalogueEntries(
    { actor: owner, kind, query: parseCatalogueListQuery({ offset: "2000" }) },
    dependencies,
  );

  expectEqual(beyond.entries.length, 0, `${kind}: a page past the end holds no rows`);
  expectEqual(beyond.nextOffset, null, `${kind}: and offers no next page`);

  // the query is the index's order and the tenant's own rows
  const lastQuery = at(db.queries, db.queries.length - 1, `${kind} last query`);

  expect(lastQuery.includes("order=created_at.desc,id.desc"), `${kind}: the query asks for the index order`);
  expect(lastQuery.includes(`company_id=eq.${COMPANY_A}`), `${kind}: scoped to the actor's company`);
  expect(lastQuery.includes("deleted_at=is.null"), `${kind}: live rows only`);
  expect(lastQuery.includes("limit=26"), `${kind}: one row more than the page, to prove a next page exists`);
  expect(!lastQuery.includes("count"), `${kind}: and no count, which would be a second scan`);

  // only the owner reads the catalogue
  for (const roles of [["compliance_kyc"], ["finance_ops"], ["support"], ["ceo"], ["super_admin"], ["blogger"]] as const) {
    const refused = await rejectionOf(() =>
      listCatalogueEntries(
        {
          actor: actorOf([...roles], COMPANY_A, { userId: OFFICE_ID }),
          kind,
          query: parseCatalogueListQuery({}),
        },
        dependencies,
      ),
    );

    expect(isAppError(refused) && refused.code === "PERMISSION_DENIED", `${kind}: the role ${roles[0]} may not list the catalogue`);
  }

  // and another merchant's rows are not in this one's page
  const otherPage = await listCatalogueEntries(
    { actor: otherOwner, kind, query: parseCatalogueListQuery({}) },
    depsOf(db),
  );

  expectEqual(otherPage.entries.length, 0, `${kind}: another merchant sees none of these rows`);

  // the two catalogues never read each other's rows
  const crossed = await listCatalogueEntries(
    { actor: owner, kind: kind === "product" ? "service" : "product", query: parseCatalogueListQuery({}) },
    depsOf(db),
  );

  expectEqual(crossed.entries.length, 0, `${kind}: the other catalogue holds none of these rows`);
}

async function checkSearch(kind: CatalogueKind): Promise<void> {
  const db = createDb();
  const dependencies = depsOf(db);
  const codeColumn = CATALOGUE_CODE_COLUMN[kind];

  await createCatalogueEntry(
    {
      actor: owner,
      kind,
      body:
        kind === "product"
          ? { name: "Brass desk lamp", sku: "LAMP-BR-01", description: "warm white bulb", unit_price: "42.50", currency: "USD", unit: "item" }
          : { name: "Brass polish hour", code: "LAMP-BR-01", description: "warm white finish", unit_price: "42.50", currency: "USD", unit: "hour" },
    },
    dependencies,
  );
  await createCatalogueEntry(
    {
      actor: owner,
      kind,
      body:
        kind === "product"
          ? { name: "Steel bracket", sku: "BRK-02", description: null, unit_price: "9", currency: "USD", unit: "unit" }
          : { name: "Steel fitting", code: "BRK-02", description: null, unit_price: "9", currency: "USD", unit: "unit" },
    },
    dependencies,
  );

  async function searchOf(term: string): Promise<readonly string[]> {
    const page = await listCatalogueEntries(
      { actor: owner, kind, query: parseCatalogueListQuery({ search: term }) },
      depsOf(db),
    );

    return page.entries.map((entry) => entry.name);
  }

  // the name is searchable
  expectDeepEqual(await searchOf("brass"), ["Brass desk lamp"].map((name) => (kind === "product" ? name : "Brass polish hour")), `${kind}: a name matches case insensitively`);

  // so is the code, and so is the description
  expectDeepEqual(await searchOf("BRK-02"), [kind === "product" ? "Steel bracket" : "Steel fitting"], `${kind}: the code matches`);
  expectEqual((await searchOf("warm")).length, 1, `${kind}: a word in the description matches`);
  expectEqual((await searchOf("nothing")).length, 0, `${kind}: a term nothing carries matches nothing`);

  // the code colon aliases the column, so a search names the kind's own column
  const searched = at(db.queries, db.queries.length - 1, `${kind} last search query`);

  expect(searched.includes(`or=(name.ilike.`), `${kind}: the filter is an or of ilike clauses`);
  expect(searched.includes(`${codeColumn}.ilike.`), `${kind}: including the kind's own code column`);
  expect(searched.includes("description.ilike."), `${kind}: and the description`);
  expect(!searched.includes("sku.ilike.") || kind === "product", `${kind}: no clause on the other catalogue's column`);

  /**
   * A term outside the alphabet is reported and dropped - the page widens to the whole catalogue - and
   * the PostgREST structure characters never reach the filter.
   */
  for (const hostile of ["a,b", "a)b", "a*b", "a.b", "a:b", "a%25b", 'a"b', "a\\b"]) {
    const query = parseCatalogueListQuery({ search: hostile });
    const page = await listCatalogueEntries({ actor: owner, kind, query }, depsOf(db));
    const lastSearch = at(db.queries, db.queries.length - 1, `${kind} refused-term query`);

    expect(
      query.problems.some((problem) => problem.field === "search" && problem.rule === "invalid_format") ||
        hostile === "a.b",
      `${kind}: the term ${JSON.stringify(hostile)} is reported`,
    );
    expectEqual(page.entries.length, hostile === "a.b" ? 0 : 2, `${kind}: and dropped, so the list is not narrowed by it`);
    expect(!lastSearch.includes("or=(") || hostile === "a.b", `${kind}: no filter was built from ${JSON.stringify(hostile)}`);
  }

  // a dot is a legitimate character in a name, so it searches rather than being refused
  expectEqual(parseCatalogueListQuery({ search: "a.b" }).problems.length, 0, `${kind}: a dot is allowed in a search`);

  // an over-long term is refused as too_long rather than truncated
  const long = parseCatalogueListQuery({ search: "x".repeat(CATALOGUE_SEARCH_MAXIMUM_LENGTH + 1) });

  expectDeepEqual(long.problems, [{ field: "search", rule: "too_long" }], `${kind}: an over-long search is too_long`);

  // control characters are stripped before the rule runs
  expectEqual(parseCatalogueListQuery({ search: "brass\u0007" }).filters.search, "brass", `${kind}: a control character is removed`);

  // an offset that is not a number is reported and the list starts at the newest row
  expectDeepEqual(parseCatalogueListQuery({ offset: "abc" }).problems, [{ field: "offset", rule: "invalid_format" }], `${kind}: a malformed offset is reported`);
  expectEqual(parseCatalogueListQuery({ offset: "abc" }).offset, 0, `${kind}: and the list starts at the newest row`);

  // an offset off the page grid lands on the page that holds it
  expectEqual(parseCatalogueListQuery({ offset: "30" }).offset, 25, `${kind}: 30 lands on the page holding it`);
  expectEqual(parseCatalogueListQuery({ offset: "99999" }).offset, CATALOGUE_LIST_MAXIMUM_OFFSET, `${kind}: and the cap holds`);
}

/* ---- STEP 109: the removal ---- */

async function checkDelete(kind: CatalogueKind): Promise<void> {
  const db = createDb();
  const audit = createInMemoryAuditTrail();
  const dependencies = depsOf(db, audit);
  const body = kind === "product" ? PRODUCT_BODY : SERVICE_BODY;
  const created = await createCatalogueEntry({ actor: owner, kind, body }, dependencies);

  const removed = await deleteCatalogueEntry(
    { actor: owner, kind, entryId: created.id },
    dependencies,
  );

  expectEqual(removed.id, created.id, `${kind}: the removal answers the row it removed`);

  // the row is marked, not erased - an invoice line will point at it
  const stored = at(db.rows[kind], 0, `${kind} stored row`);

  expect(stored["deleted_at"] !== null, `${kind}: the row stays and is marked`);
  expectEqual(db.rows[kind].length, 1, `${kind}: nothing was erased`);

  const lastUpdate = at(db.updates, db.updates.length - 1, `${kind} removal update`);

  expectDeepEqual(Object.keys(lastUpdate.values), ["deleted_at"], `${kind}: only the marker was written`);
  expect(
    lastUpdate.query.includes(`company_id=eq.${COMPANY_A}`) && lastUpdate.query.includes("deleted_at=is.null"),
    `${kind}: scoped to one live row of the actor's company`,
  );

  // it is gone from the read of one row and from the list
  const gone = await rejectionOf(() =>
    getCatalogueEntry({ actor: owner, kind, entryId: created.id }, dependencies),
  );

  expect(isAppError(gone) && gone.code === "RESOURCE_NOT_FOUND", `${kind}: a removed row is a 404`);

  const page = await listCatalogueEntries(
    { actor: owner, kind, query: parseCatalogueListQuery({}) },
    depsOf(db),
  );

  expectEqual(page.entries.length, 0, `${kind}: and is not on the list`);

  // the audit entry names the row and never copies the description
  const entry = at(
    audit.entries.filter((candidate) => candidate.action === CATALOGUE_DELETED_AUDIT_ACTION[kind]),
    0,
    `${kind} delete audit`,
  );

  expectEqual(entry.action, `${kind}.deleted`, `${kind}: audited as the removal action`);
  expectEqual(entry.entityId, created.id, `${kind}: naming the row`);
  expectEqual(entry.companyId, COMPANY_A, `${kind}: and the company`);
  expectEqual(entry.actorUserId, OWNER_ID, `${kind}: and the actor`);
  expect(
    !JSON.stringify(entry.payload).includes("Adjustable arm") &&
      !JSON.stringify(entry.payload).includes("Advisory work"),
    `${kind}: the description never reaches the audit trail`,
  );

  // removing it again is a 404, not a second marker
  const again = await rejectionOf(() =>
    deleteCatalogueEntry({ actor: owner, kind, entryId: created.id }, dependencies),
  );

  expect(isAppError(again) && again.code === "RESOURCE_NOT_FOUND", `${kind}: a second removal is a 404`);

  // another merchant cannot remove it
  const second = await createCatalogueEntry(
    { actor: owner, kind, body: { ...body, [CATALOGUE_CODE_COLUMN[kind]]: "OTHER-1", name: "Other" } },
    dependencies,
  );
  const foreign = await rejectionOf(() =>
    deleteCatalogueEntry({ actor: otherOwner, kind, entryId: second.id }, dependencies),
  );

  expect(isAppError(foreign) && foreign.code === "RESOURCE_NOT_FOUND", `${kind}: a foreign removal is a 404`);
  expect(at(db.rows[kind], 1, `${kind} second row`)["deleted_at"] === null, `${kind}: and the row is untouched`);

  // a non-owner may not remove
  const roleDenied = await rejectionOf(() =>
    deleteCatalogueEntry(
      { actor: actorOf(["finance_ops"], COMPANY_A, { userId: OFFICE_ID }), kind, entryId: second.id },
      dependencies,
    ),
  );

  expect(isAppError(roleDenied) && roleDenied.code === "PERMISSION_DENIED", `${kind}: a non-owner role may not remove`);

  // the code a removed row held is free again, which is what a mistyped code needs
  const reused = await createCatalogueEntry({ actor: owner, kind, body }, depsOf(db));

  expectEqual(reused.values.code, created.values.code, `${kind}: a removed row releases its code`);

  // a row that is still live after the write is a lost race, not a success
  const racing = createDb();
  const stuck = await seed(racing, kind, owner, 1, "race");
  const frozen = createCatalogueRest(racing);
  const stuckDeps = {
    rest: {
      ...frozen,
      // an update that reports success and changes nothing is what a lost race looks like
      update: (): Promise<void> => Promise.resolve(),
    } as RestClient,
    audit: createInMemoryAuditTrail(),
    now: () => NOW,
  };
  const conflicted = await rejectionOf(() =>
    deleteCatalogueEntry({ actor: owner, kind, entryId: at(stuck, 0, `${kind} racing row`).id }, stuckDeps),
  );

  expect(isAppError(conflicted) && conflicted.code === "CONFLICT", `${kind}: a removal that matched nothing is a CONFLICT`);
  expectDeepEqual(
    detailsOf(conflicted),
    [{ field: kind, rule: "already_changed" }],
    `${kind}: named as an entry that changed under the writer`,
  );
}

/* ---- STEP 111: the CSV import ---- */

/**
 * A price list of four rows: two good, one bad price, one bad unit.
 *
 * The unit column is deliberately blank on the row that lands, because a blank unit taking the
 * catalogue's default is one of the things this import decides for itself - and the two catalogues
 * disagree on that default, so a stated `item` would hide the decision.
 */
const IMPORT_FILE = [
  "Name,SKU,Price,Unit,Description",
  "Desk lamp,LAMP-01,42.50,,Adjustable arm",
  "Side table,TABLE-01,19.999,,A small table",
  "Bad price,BAD-01,1 200,item,",
  "Bad unit,BAD-02,10,stone,",
].join("\n");

async function checkImportReport(kind: CatalogueKind): Promise<void> {
  const db = createDb();
  const audit = createInMemoryAuditTrail();
  const outcome = await importCatalogueEntries(
    { actor: owner, kind, text: IMPORT_FILE },
    depsOf(db, audit),
  );

  expect(outcome.ok, `${kind}: a file with two bad rows still imports the good ones`);

  if (!outcome.ok) {
    return;
  }

  const report = outcome.report;

  expectEqual(report.kind, kind, `${kind}: the report names its catalogue`);
  expectEqual(report.created, 2, `${kind}: the two good rows were created`);
  expectEqual(report.refused, 2, `${kind}: the two bad rows were refused`);
  expectEqual(report.rows.length, 4, `${kind}: and every row is reported`);
  expectDeepEqual(
    report.columns,
    ["name", "code", "unit_price", "unit", "description"],
    `${kind}: the header named its five fields, with the code normalised to one name`,
  );

  // the refusals name the right line and the right field
  expectDeepEqual(
    at(report.rows, 2, `${kind} third row`).problems,
    [{ field: "unit_price", rule: "invalid_format" }],
    `${kind}: a price with a separator is refused as invalid_format`,
  );
  expectDeepEqual(
    at(report.rows, 3, `${kind} fourth row`).problems,
    [{ field: "unit", rule: "invalid_format" }],
    `${kind}: a unit outside the list is refused as invalid_format`,
  );
  expectEqual(at(report.rows, 2, `${kind} third row`).line, 4, `${kind}: the refusal names the file's line`);
  expectEqual(at(report.rows, 0, `${kind} first row`).name, "Desk lamp", `${kind}: a created row names the entry`);

  // the price reached the row through the reader, at scale four, with no float anywhere
  const first = at(db.rows[kind], 0, `${kind} first stored row`);

  // the row crosses the wire as text, which is how a bigint survives JSON: 425000, never 4250.00
  expectEqual(first["unit_price_minor"], "425000", `${kind}: 42.50 is written as 425000 minor units`);
  expectEqual(
    at(db.rows[kind], 1, `${kind} second stored row`)["unit_price_minor"],
    "199990",
    `${kind}: 19.999 is written as 199990, which is what the scale keeps`,
  );

  // a blank unit takes the catalogue's own default, from the migration
  expectEqual(first["unit"], CATALOGUE_DEFAULT_UNIT[kind], `${kind}: a blank unit takes the default`);

  // the code landed in the kind's own column
  expectEqual(
    first[CATALOGUE_CODE_COLUMN[kind]],
    "LAMP-01",
    `${kind}: the code is stored in the catalogue's own column`,
  );

  // each created row wrote its own audit entry, and the run wrote one summary
  const created = audit.entries.filter((entry) => entry.action === CATALOGUE_CREATED_AUDIT_ACTION[kind]);
  const summaries = audit.entries.filter((entry) => entry.action === "catalogue.imported");

  expectEqual(created.length, 2, `${kind}: each created entry is audited`);
  expectEqual(summaries.length, 1, `${kind}: and the run has one summary entry`);

  const summary = at(summaries, 0, `${kind} import summary`);
  const payload = summary.payload as Readonly<Record<string, unknown>>;

  expectEqual(summary.companyId, COMPANY_A, `${kind}: the summary names the company`);
  expectEqual(summary.actorUserId, OWNER_ID, `${kind}: and the actor`);
  expectEqual(payload["kind"], kind, `${kind}: and the catalogue`);
  expectEqual(payload["created"], 2, `${kind}: with how many were taken`);
  expectEqual(payload["refused"], 2, `${kind}: and how many were not`);

  // the report never repeats a value from the file, beyond the name of a row it created
  expect(
    !JSON.stringify(report.rows).includes("1 200"),
    `${kind}: the report never repeats the price that failed`,
  );
  expect(
    !JSON.stringify(report).includes("Adjustable arm"),
    `${kind}: nor a description it imported`,
  );
}

async function checkImportDefaults(kind: CatalogueKind): Promise<void> {
  // name and price alone is the smallest useful file, and the two defaults fill the rest
  const minimal = await importCatalogueEntries(
    { actor: owner, kind, text: "Name,Price\nConsulting hour,125" },
    depsOf(createDb()),
  );

  expect(minimal.ok && minimal.report.created === 1, `${kind}: a name and a price are enough`);
  expectDeepEqual(
    minimal.ok ? minimal.report.columns : [],
    ["name", "unit_price"],
    `${kind}: and the header needed nothing else`,
  );

  // a stated unit and currency win over the defaults
  const stated = createDb();
  const explicit = await importCatalogueEntries(
    { actor: owner, kind, text: "Name,Price,Unit,Currency\nSetup,99,day,USD" },
    depsOf(stated),
  );

  expect(explicit.ok && explicit.report.created === 1, `${kind}: a stated unit and currency import`);
  expectEqual(at(stated.rows[kind], 0, `${kind} stated row`)["unit"], "day", `${kind}: the stated unit wins`);

  // a currency the platform does not charge in is refused rather than replaced
  const badCurrency = await importCatalogueEntries(
    { actor: owner, kind, text: "Name,Price,Currency\nSetup,99,EUR" },
    depsOf(createDb()),
  );

  expectDeepEqual(
    badCurrency.ok ? (badCurrency.report.rows[0]?.problems ?? []) : [],
    [{ field: "currency", rule: "invalid_format" }],
    `${kind}: a currency the platform does not charge in is refused`,
  );

  // the price is the one thing an import cannot guess, so a file without it is refused once
  const noPrice = await importCatalogueEntries(
    { actor: owner, kind, text: "Name,SKU\nDesk lamp,LAMP-01" },
    depsOf(createDb()),
  );

  expect(
    !noPrice.ok && noPrice.problem === "header_missing_price",
    `${kind}: a file with no price column is refused as header_missing_price`,
  );
}

async function checkImportHeaders(kind: CatalogueKind): Promise<void> {
  /** The outcome of importing one file, against an empty catalogue. */
  const importOf = async (text: string) =>
    importCatalogueEntries({ actor: owner, kind, text }, depsOf(createDb()));

  // The header spellings a spreadsheet actually produces, including the price aliases. Each case brings
  // its own value line: a row wider than its own header is `row_too_wide`, so a shared line would test
  // the fixture rather than the header.
  for (const [header, values, expected] of [
    ["Name,Price", "Desk lamp,42.50", ["name", "unit_price"]],
    ["PRODUCT NAME,UNIT PRICE", "Desk lamp,42.50", ["name", "unit_price"]],
    ["name,rate", "Desk lamp,42.50", ["name", "unit_price"]],
    ["Title,Selling Price,UOM", "Desk lamp,42.50,item", ["name", "unit_price", "unit"]],
    ["Item,SKU,Price,Details", "Desk lamp,LAMP-01,42.50,warm white", ["name", "code", "unit_price", "description"]],
    [
      "Service,Code,Amount,Unit of Measure,Currency",
      "Setup,SET-1,42.50,hour,USD",
      ["name", "code", "unit_price", "unit", "currency"],
    ],
  ] as const) {
    const outcome = await importOf(`${header}\n${values}`);

    expect(outcome.ok, `${kind}: the header ${header} is understood`);
    expectDeepEqual(
      outcome.ok ? outcome.report.columns : [],
      [...expected],
      `${kind}: the header ${header} maps to ${expected.join(",")}`,
    );
  }

  // an unknown column is ignored and named, so a re-import of an export works
  const withExtras = await importOf("Name,Price,id,Created At\nDesk lamp,42.50,abc,2026-01-01");

  expect(
    withExtras.ok && withExtras.report.ignoredColumns.length === 2,
    `${kind}: a column the import does not use is ignored and named`,
  );

  // a file with no name column, and one with two price columns
  const noName = await importOf("SKU,Price\nLAMP-01,42.50");

  expect(!noName.ok && noName.problem === "header_missing", `${kind}: a file with no name column is refused`);
  expect(!noName.ok && noName.line === 1, `${kind}: naming the header line`);

  const twoPrices = await importOf("Name,Price,Unit Price\nDesk lamp,42.50,40");

  expect(
    !twoPrices.ok && twoPrices.problem === "header_duplicate",
    `${kind}: two price columns are refused as header_duplicate`,
  );

  // a row wider than the header is a shifted row
  const wide = await importOf("Name,Price\nDesk lamp,42.50,item");

  expect(!wide.ok && wide.problem === "row_too_wide", `${kind}: a row wider than the header is refused`);
  expect(!wide.ok && wide.line === 2, `${kind}: naming the row`);

  // a file past the row ceiling is refused before any row is written
  const tooMany = await importOf(
    `Name,Price\n${Array.from({ length: CATALOGUE_IMPORT_MAXIMUM_ROWS + 1 }, () => "Desk lamp,1").join("\n")}`,
  );

  expect(
    !tooMany.ok && tooMany.problem === "too_many_rows",
    `${kind}: a file past the row ceiling is refused as too_many_rows`,
  );

  // a header alone is an empty import; an empty file is a refusal about the file
  const headerOnly = await importOf("Name,Price");

  expect(
    headerOnly.ok && headerOnly.report.created === 0 && headerOnly.report.refused === 0,
    `${kind}: a header alone is an empty import`,
  );

  const empty = await importOf("");

  expect(!empty.ok && empty.problem === "empty", `${kind}: an empty file is refused as empty`);

  // a broken quote names the line it broke on
  const broken = await importOf('Name,Price\nDesk lamp,42.50\n"unclosed,1');

  expect(!broken.ok && broken.problem === "invalid_quote", `${kind}: a broken quote is refused`);
  expect(!broken.ok && broken.line === 3, `${kind}: naming the line it broke on`);
}

/**
 * The form and the import must judge one body the same way.
 *
 * This is the assertion that keeps the importer from becoming a second, looser definition of a valid
 * catalogue row - the same assertion STEP 110's gate makes for clients, applied to the two things a
 * catalogue adds: a price and a unit.
 */
async function checkImportAgreement(kind: CatalogueKind): Promise<void> {
  const codeColumn = CATALOGUE_CODE_COLUMN[kind];

  const bodies: readonly (readonly [string, Record<string, string>])[] = [
    ["a missing name", { name: "", unit_price: "10" }],
    ["a name past its ceiling", { name: "x".repeat(161), unit_price: "10" }],
    ["a price that is not a price", { name: "Desk lamp", unit_price: "free" }],
    ["a price with a comma", { name: "Desk lamp", unit_price: "1,200" }],
    ["a price past the ceiling", { name: "Desk lamp", unit_price: "999999999999.9999" }],
    ["a price with five decimals", { name: "Desk lamp", unit_price: "1.23456" }],
    ["a negative price", { name: "Desk lamp", unit_price: "-5" }],
    ["a unit outside the list", { name: "Desk lamp", unit_price: "10", unit: "stone" }],
    ["a currency the platform cannot charge", { name: "Desk lamp", unit_price: "10", currency: "EUR" }],
    ["a code with a space", { name: "Desk lamp", unit_price: "10", [codeColumn]: "LA MP" }],
    ["a code starting with a hyphen", { name: "Desk lamp", unit_price: "10", [codeColumn]: "-LAMP" }],
    ["a description past its ceiling", { name: "Desk lamp", unit_price: "10", description: "x".repeat(2_001) }],
  ];

  for (const [description, body] of bodies) {
    // A CSV cell may be absent and the import fills it; a form body may not, and the screen sends the
    // default its select shows. So the two are given the same defaults before they are compared, which
    // keeps this honest about what it is proving: the values that are present are judged identically.
    const complete = {
      unit: CATALOGUE_DEFAULT_UNIT[kind],
      currency: CATALOGUE_CURRENCIES[0],
      ...body,
    };

    const direct = await rejectionOf(() =>
      createCatalogueEntry({ actor: owner, kind, body: complete }, depsOf(createDb())),
    );
    const directDetails = isAppError(direct) && direct.code === "VALIDATION_FAILED" ? direct.details : [];

    expect(directDetails.length > 0, `${kind}: the form refuses ${description}`);

    // the same values through a one-row file, quoted so a comma inside one cannot shift the row
    const fields = Object.keys(complete);
    const header = fields.join(",");
    const values = fields.map((field) => `"${(complete[field as keyof typeof complete] ?? "").replaceAll('"', '""')}"`);

    const outcome = await importCatalogueEntries(
      { actor: owner, kind, text: `${header}\n${values.join(",")}` },
      depsOf(createDb()),
    );

    expect(outcome.ok, `${kind}: the import reads the one row file for ${description}`);
    expectEqual(
      outcome.ok ? outcome.report.refused : -1,
      1,
      `${kind}: the import refuses ${description} exactly as the form does`,
    );

    const problems = outcome.ok ? (outcome.report.rows[0]?.problems ?? []) : [];

    expectDeepEqual(
      problems.map((problem) => problem.field).sort(),
      directDetails.map((detail) => detail.field).sort(),
      `${kind}: and names the same fields for ${description}`,
    );
    expectDeepEqual(
      problems.map((problem) => problem.rule).sort(),
      directDetails.map((detail) => detail.rule).sort(),
      `${kind}: and the same rules for ${description}`,
    );
  }
}

async function checkImportDuplicates(kind: CatalogueKind): Promise<void> {
  const db = createDb();
  const codeColumn = CATALOGUE_CODE_COLUMN[kind];

  // a code used twice inside one file: the first lands, the second is refused on its own line
  const twice = await importCatalogueEntries(
    { actor: owner, kind, text: `Name,${codeColumn},Price\nDesk lamp,LAMP-01,42.50\nDesk lamp again,lamp-01,40` },
    depsOf(db),
  );

  expect(twice.ok && twice.report.created === 1, `${kind}: the first of two identical codes is created`);
  expect(twice.ok && twice.report.refused === 1, `${kind}: and the second is refused`);
  expectDeepEqual(
    twice.ok ? (twice.report.rows[1]?.problems ?? []) : [],
    [{ field: codeColumn, rule: "already_used" }],
    `${kind}: naming the code as already used, case insensitively`,
  );
  expect(twice.ok && twice.report.rows[1]?.line === 3, `${kind}: on the line that caused it`);

  // an entry the merchant already has is a row refusal, so the rest of the file still lands
  await createCatalogueEntry(
    { actor: owner, kind, body: { name: "Existing", [codeColumn]: "TAKEN-1", unit_price: "1", currency: "USD", unit: CATALOGUE_DEFAULT_UNIT[kind] } },
    depsOf(db),
  );

  const mixed = await importCatalogueEntries(
    { actor: owner, kind, text: `Name,${codeColumn},Price\nNew One,NEW-1,10\nClash,TAKEN-1,20` },
    depsOf(db),
  );

  expect(mixed.ok && mixed.report.created === 1, `${kind}: a file naming an existing entry still imports the rest`);
  expectDeepEqual(
    mixed.ok ? (mixed.report.rows[1]?.problems ?? []) : [],
    [{ field: codeColumn, rule: "already_used" }],
    `${kind}: and reports the clash on that row`,
  );
}

async function checkImportTenancy(kind: CatalogueKind): Promise<void> {
  const db = createDb();
  const file = "Name,Price\nDesk lamp,42.50";

  // only the owner may import, exactly as only the owner may create
  for (const roles of [["compliance_kyc"], ["finance_ops"], ["support"], ["ceo"], ["super_admin"], ["blogger"]] as const) {
    const refused = await rejectionOf(() =>
      importCatalogueEntries(
        { actor: actorOf([...roles], COMPANY_A, { userId: OFFICE_ID }), kind, text: file },
        depsOf(createDb()),
      ),
    );

    expect(
      isAppError(refused) && refused.code === "PERMISSION_DENIED",
      `${kind}: the role ${roles[0]} may not import the catalogue`,
    );
  }

  const platformAccount = await rejectionOf(() =>
    importCatalogueEntries({ actor: desk, kind, text: file }, depsOf(createDb())),
  );

  expect(isAppError(platformAccount), `${kind}: an account with no company cannot import into one`);

  // everything created belongs to the actor's company, and another merchant's import is their own
  const imported = await importCatalogueEntries({ actor: owner, kind, text: file }, depsOf(db));

  expect(imported.ok && imported.report.created === 1, `${kind}: the owner imports one entry`);
  expectEqual(at(db.rows[kind], 0, `${kind} imported row`)["company_id"], COMPANY_A, `${kind}: scoped to the actor's company`);

  const other = await importCatalogueEntries({ actor: otherOwner, kind, text: file }, depsOf(db));

  expect(other.ok && other.report.created === 1, `${kind}: another merchant imports the same file`);
  expectEqual(at(db.rows[kind], 1, `${kind} second row`)["company_id"], COMPANY_B, `${kind}: into their own company`);
  expectEqual(db.rows[kind].length, 2, `${kind}: which is a second row, not an overwrite`);
}

async function checkImportSources(): Promise<void> {
  for (const path of [
    "services/products/catalogue-import.ts",
    "app/api/products/import/route.ts",
    "app/api/services/import/route.ts",
    "app/(dashboard)/products/catalogue-import-form.tsx",
    "app/(dashboard)/products/catalogue-import-screen.tsx",
    "app/(dashboard)/products/import/page.tsx",
    "app/(dashboard)/services/import/page.tsx",
  ]) {
    const source = await readRepositoryFile(path);

    expect(source.length > 0, `${path} exists`);
    expect(source.split("\n", 1)[0]?.trim() === `// path: ${path}`, `${path} starts with its path comment`);
    expect(!/[^\u0009\u000a\u000d\u0020-\u007e]/u.test(source.replaceAll("\ufeff", "")), `${path} is ASCII only`);
  }

  /** The source with its comment lines removed, so a comment naming a symbol cannot satisfy a check. */
  const codeOf = (source: string): string =>
    source
      .split("\n")
      .filter((line) => {
        const trimmed = line.trim();

        return !trimmed.startsWith("*") && !trimmed.startsWith("//") && !trimmed.startsWith("/*");
      })
      .join("\n");

  const importModule = await readRepositoryFile("services/products/catalogue-import.ts");
  const importCode = codeOf(importModule);

  // the importer validates by calling the same service, never by writing a row of its own
  expect(importModule.includes("createCatalogueEntry("), "every row goes through createCatalogueEntry");
  expectEqual(/insertReturning\(/u.test(importModule), false, "the import opens no insert of its own");
  expectEqual(/CATALOGUE_TABLES/u.test(importModule), false, "and names no table");
  expect(importModule.includes("requireAnyRole\(") === false, "so it states no role of its own either");

  // money never passes through a float, and the price is not parsed here at all
  expectEqual(/parseFloat|Number\(/u.test(importCode), false, "no amount passes through a float parse");
  expectEqual(/priceToMinor/u.test(importCode), false, "the price is not even converted here: the service does it");

  // the reader is STEP 110's, reused rather than copied
  expect(importModule.includes('from "../clients/csv.ts"'), "the reader is STEP 110's csv module");

  const csvModule = await readRepositoryFile("services/clients/csv.ts");
  const secondReader = await readRepositoryFile("services/products/catalogue-import.ts");

  expect(!secondReader.includes("function readCsv"), "and is not reimplemented here");
  expect(csvModule.includes("export function readCsv"), "which still exports the one reader");

  // a refused row does not stop the run, and an outage does
  expect(importModule.includes("catch (error)"), "a row failure is caught per row");
  expect(importModule.includes("throw error"), "and a failure that is not the row's stops the run");

  // the routes: one factory, and the second route is the factory called with the other catalogue
  for (const routePath of ["app/api/products/import/route.ts", "app/api/services/import/route.ts"]) {
    const source = await readRepositoryFile(routePath);

    expect(source.includes("createCatalogueImportRoute"), `${routePath} builds its handler from the factory`);
  }

  const serviceRoute = codeOf(await readRepositoryFile("app/api/services/import/route.ts"));

  expect(
    !serviceRoute.includes("request.text()") && !serviceRoute.includes("requireCsrfToken"),
    "the service import route holds no handler of its own: it delegates to the factory",
  );

  const route = await readRepositoryFile("app/api/products/import/route.ts");

  expect(route.includes("requireCsrfToken("), "the import route checks the token");
  expect(
    route.indexOf("requireCsrfToken(") < route.indexOf("readRequestActor("),
    "before it looks the session up",
  );
  expect(
    route.indexOf("requireCsrfToken(") < route.indexOf("const bodyText = await request.text()"),
    "and before it reads the body",
  );
  expect(route.includes("PAYLOAD_TOO_LARGE"), "it bounds the body");
  expect(
    route.includes('{ field: "file", rule: "invalid_type" }'),
    "and refuses a body that is not CSV, naming the field and the rule",
  );
  expect(
    !route.includes('throw new AppError("UNSUPPORTED_MEDIA_TYPE"'),
    "without borrowing a shared sentence that claims the endpoint takes JSON",
  );

  const csrf = await readRepositoryFile("lib/security/csrf.ts");

  expect(csrf.includes('"/api/products/import"'), "the product import route is on the protected list");
  expect(csrf.includes('"/api/services/import"'), "and so is the service import route");

  // the screens post a file through the one form, with the token
  const form = await readRepositoryFile("app/(dashboard)/products/catalogue-import-form.tsx");

  expect(form.includes('method: "POST"'), "the form posts");
  expect(form.includes("csrfHeaders("), "carrying the CSRF token");
  expect(form.includes('type="file"'), "it takes a file");
  expect(form.includes("accept="), "of the types it accepts");
  expect(form.includes("report.rows"), "and prints the report row by row");
  expect(form.includes("catalogue.ruleTooLarge"), "and words the price ceiling's refusal");

  // the list is the way in, for both catalogues
  const screens = await readRepositoryFile("app/(dashboard)/products/catalogue-screens.tsx");

  expect(screens.includes("${path}/import"), "the list links to the import");
  expect(screens.includes("catalogue.importLinkProducts"), "with the product's label");
  expect(screens.includes("catalogue.importLinkServices"), "and the service's");

  // the screen prints its limits from the service, so no number is typed twice
  const screen = await readRepositoryFile("app/(dashboard)/products/catalogue-import-screen.tsx");

  expect(screen.includes("CATALOGUE_IMPORT_MAXIMUM_ROWS"), "the screen prints the row ceiling it enforces");
  expect(screen.includes("MAXIMUM_CSV_ROWS"), "and the reader's own record ceiling");
  expect(screen.includes("CATALOGUE_DEFAULT_UNIT[kind]"), "and the default unit of the catalogue it imports");

  // and the form refuses an oversized file before uploading it, using the same body bound
  const importForm = await readRepositoryFile("app/(dashboard)/products/catalogue-import-form.tsx");

  expect(importForm.includes("MAXIMUM_FILE_BYTES"), "the form bounds the file it will upload");
  expect(importForm.includes("catalogue.importLocalTooLarge"), "and says so in the merchant's words");
  expectEqual(
    importForm.includes("3_145_728"),
    true,
    "with the ceiling as the route's own body bound times three, so the two agree",
  );

  // STEP 111 writes no migration: the import writes the two tables 0020 and 0021 describe
  const productsMigration = await readRepositoryFile("migrations/0020_products.sql");

  expect(
    productsMigration.includes("unit_price_minor bigint"),
    "the imported price lands in the column 0020 declares",
  );
  expect(
    productsMigration.includes("unit in ('item', 'unit', 'hour', 'day', 'week', 'month', 'project')"),
    "and the unit list the import fills from is the migration's own",
  );
}

/* ---- sources ---- */

async function checkSources(): Promise<void> {
  const paths = [
    "services/products/price.ts",
    "services/products/catalogue-fields.ts",
    "services/products/catalogue.ts",
    "services/products/verify.ts",
    "app/api/products/route.ts",
    "app/api/products/[id]/route.ts",
    "app/api/services/route.ts",
    "app/api/services/[id]/route.ts",
    "app/(dashboard)/products/catalogue-form.tsx",
    "app/(dashboard)/products/catalogue-screens.tsx",
    "app/(dashboard)/products/page.tsx",
    "app/(dashboard)/products/new/page.tsx",
    "app/(dashboard)/products/[id]/page.tsx",
    "app/(dashboard)/services/page.tsx",
    "app/(dashboard)/services/new/page.tsx",
    "app/(dashboard)/services/[id]/page.tsx",
  ];

  for (const path of paths) {
    const source = await readRepositoryFile(path);
    expect(source.length > 0, `${path} exists`);
    expect(!/[^\u0009\u000a\u000d\u0020-\u007e]/u.test(source), `${path} is ASCII only`);
    expect(source.split("\n", 1)[0]?.trim() === `// path: ${path}`, `${path} starts with its path comment`);
  }

  for (const path of paths.filter((candidate) => !candidate.endsWith("verify.ts"))) {
    const source = await readRepositoryFile(path);
    expect(!/console\.log\(/u.test(source), `${path} never writes to the console`);
  }

  // the four routes check the token once each and are on the protected list
  const csrfList = await readRepositoryFile("lib/security/csrf.ts");

  for (const routePath of ["app/api/products/route.ts", "app/api/products/[id]/route.ts"]) {
    const source = await readRepositoryFile(routePath);
    expect(source.includes("requireCsrfToken("), `${routePath} checks the token`);
    expect(source.indexOf("requireCsrfToken(") < source.indexOf("request.text()"), `${routePath} checks the token before the body`);
  }

  for (const routePath of ["app/api/services/route.ts", "app/api/services/[id]/route.ts"]) {
    const source = await readRepositoryFile(routePath);
    const factory = routePath.includes("[id]") ? "createCatalogueEntryRoute" : "createCatalogueRoute";
    expect(source.includes(factory), `${routePath} builds its handler from the product route's factory`);
    expect(/from "\.\.\/(\.\.\/)?products\//u.test(source), `${routePath} imports that factory rather than copying it`);
    expect(!source.includes("request.text()"), `${routePath} hold no handler of its own`);
  }

  // The `[id]` route answers exactly `GET`, `POST` and the STEP 109 `DELETE`; the create route answers
  // `POST` alone. Nothing else, so no method exists here that no screen asks for.
  for (const routePath of ["app/api/products/[id]/route.ts", "app/api/services/[id]/route.ts"]) {
    const source = await readRepositoryFile(routePath);

    expectEqual(
      [...source.matchAll(/^export const (GET|POST|PUT|PATCH|DELETE)\b/gmu)].map((match) => match[1]).join(","),
      "GET,POST,DELETE",
      `${routePath} answers reads, edits and removals`,
    );
    expect(
      source.includes("deleteCatalogueEntry(") === (routePath.startsWith("app/api/products/") ? true : false) ||
        source.includes("DELETE = handlers.DELETE"),
      `${routePath} removes through the catalogue service`,
    );
  }

  for (const routePath of ["app/api/products/route.ts", "app/api/services/route.ts"]) {
    const source = await readRepositoryFile(routePath);
    expect(!/export const (PUT|PATCH|DELETE)/u.test(source), `${routePath} answers no other mutation`);
  }

  expect(csrfList.includes('"/api/products"'), "the product create route is protected");
  expect(csrfList.includes('"/api/products/[id]"'), "the product edit route is protected");
  expect(csrfList.includes('"/api/services"'), "the service create route is protected");
  expect(csrfList.includes('"/api/services/[id]"'), "the service edit route is protected");

  // the service validates with zod, scopes every query, and never uses a float for money
  const service = await readRepositoryFile("services/products/catalogue.ts");
  expect(service.includes('from "zod"'), "the catalogue service validates with zod");
  expect(service.includes("company_id=eq."), "every query is company scoped");
  expect(service.includes("deleted_at=is.null"), "live reads skip deleted rows");
  expect(service.includes("requireCompanyId"), "the company comes from the actor");
  expect(service.includes("insertReturning"), "the insert reads the row back");
  expectEqual(/parseFloat|Number\(/u.test(service), false, "no amount passes through a floating point parse");
  expect(service.includes("CATALOGUE_TABLES"), "the table comes from the catalogue vocabulary, not a literal");

  const price = await readRepositoryFile("services/products/price.ts");
  expect(price.includes("BigInt"), "the price conversion is bigint arithmetic");
  expectEqual(/parseFloat|toFixed/u.test(price), false, "and never a float formatter");

  // the tables and columns the code names are the ones the migrations created
  const productsMigration = await readRepositoryFile("migrations/0020_products.sql");
  const servicesMigration = await readRepositoryFile("migrations/0021_services.sql");

  for (const migration of [productsMigration, servicesMigration]) {
    expect(migration.includes("unit_price_minor bigint"), "the price column is a bigint of minor units");
    expect(migration.includes("create unique index"), "the code has a unique index");
    expect(migration.includes("deleted_at is null"), "which counts live rows only");
    expect(migration.includes("unit in ('item', 'unit', 'hour', 'day', 'week', 'month', 'project')"), "the unit list matches the vocabulary");
    expect(migration.includes(`char_length(name) between 1 and ${CATALOGUE_FIELD_LIMITS.name.max}`), "the name ceiling matches");
    expect(migration.includes(`char_length(description) between 1 and ${CATALOGUE_FIELD_LIMITS.description.max}`), "the description ceiling matches");
  }

  expect(productsMigration.includes("products_sku_key"), "the product code index is the one the service expects");
  expect(servicesMigration.includes("services_code_key"), "the service code index is the one the service expects");
  expect(productsMigration.includes(CATALOGUE_CODE_COLUMN.product) === true, "the product code column is sku in SQL");
  expect(servicesMigration.includes(`${CATALOGUE_CODE_COLUMN.service} text`), "the service code column is code in SQL");

  for (const unit of CATALOGUE_UNITS) {
    expect(productsMigration.includes(`'${unit}'`), `the migration lists the unit ${unit}`);
  }

  // the screens use catalog keys only, and the catalogue carries every one of them
  const catalog = await readRepositoryFile("lib/i18n/strings/en.ts");
  expect(catalog.includes("catalogue: {"), "the catalog has a catalogue section");

  for (const screen of [
    "app/(dashboard)/products/catalogue-form.tsx",
    "app/(dashboard)/products/catalogue-screens.tsx",
  ]) {
    const source = await readRepositoryFile(screen);
    const keys = [...source.matchAll(/"(catalogue\.[a-zA-Z0-9_]+)"/gu)].map((match) => match[1] as string);

    for (const key of new Set(keys)) {
      const leaf = key.slice("catalogue.".length);
      expect(catalog.includes(`${leaf}:`), `the catalog carries ${key}`);
    }
  }

  // the pages are dynamic and keep the session rotating
  for (const page of [
    "app/(dashboard)/products/page.tsx",
    "app/(dashboard)/products/new/page.tsx",
    "app/(dashboard)/products/[id]/page.tsx",
    "app/(dashboard)/services/page.tsx",
    "app/(dashboard)/services/new/page.tsx",
    "app/(dashboard)/services/[id]/page.tsx",
  ]) {
    const source = await readRepositoryFile(page);
    expect(source.includes('export const dynamic = "force-dynamic"'), `${page} is read per request`);
  }

  const screens = await readRepositoryFile("app/(dashboard)/products/catalogue-screens.tsx");
  expect(screens.includes("<SessionKeeper"), "the screens keep the session rotating");
  expectEqual(screens.includes("requireAnyRole"), false, "and state no role of their own");

  // STEP 108 adds no migration: the two tables are STEP 020's and 021's
  expectEqual(CATALOGUE_KINDS.length, 2, "there are exactly two catalogues");

  // the rule vocabulary the form words is the service's own, and the manager role is the owner's
  for (const path of ["app/(dashboard)/products/catalogue-form.tsx"]) {
    const source = await readRepositoryFile(path);

    for (const rule of CATALOGUE_RULES) {
      if (rule === "not_found") {
        continue;
      }

      const camel = rule
        .split("_")
        .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
        .join("");

      expect(source.includes(`rule${camel}`), `the form words the rule ${rule}`);
    }
  }

  expectDeepEqual(CATALOGUE_MANAGE_ROLES, ["owner"], "only the owner manages a catalogue");
  // STEP 108 writes no migration: it reads the two tables `0020` and `0021` created
  const migrations = await readRepositoryFile("migrations/0020_products.sql");
  expect(migrations.includes("unit_price_minor"), "the products table is read as STEP 020 wrote it");

  // ---- STEP 109: the list, the search and the removal

  for (const path of [
    "services/products/catalogue-list.ts",
    "app/api/products/list/route.ts",
    "app/api/services/list/route.ts",
    "app/(dashboard)/products/catalogue-list-table.tsx",
    "app/(dashboard)/products/catalogue-search-form.tsx",
    "app/(dashboard)/products/delete-catalogue-form.tsx",
  ]) {
    const source = await readRepositoryFile(path);
    expect(source.length > 0, `${path} exists`);
    expect(source.split("\n", 1)[0]?.trim() === `// path: ${path}`, `${path} starts with its path comment`);
    expect(!/[^\u0009\u000a\u000d\u0020-\u007e]/u.test(source), `${path} is ASCII only`);
  }

  const listModule = await readRepositoryFile("services/products/catalogue-list.ts");

  expect(listModule.includes("requireAnyRole"), "the list applies the catalogue's role rule");
  expect(listModule.includes("requireCompanyId"), "and takes the company from the session");
  expect(listModule.includes("company_id=eq."), "the query is company scoped");
  expect(listModule.includes("deleted_at=is.null"), "and reads live rows only");
  expect(listModule.includes("priceFromMinor"), "the price is formatted by the one function allowed to");
  expectEqual(/parseFloat|toFixed/u.test(listModule), false, "never by a float");
  expectEqual(/\bselect\*|select=\*/u.test(listModule), false, "the page names its columns instead of asking for all");
  expect(listModule.includes(`"order=" + CATALOGUE_LIST_ORDER`) || listModule.includes("CATALOGUE_LIST_ORDER}"), "the order is the exported constant");
  expectEqual(CATALOGUE_LIST_ORDER, "created_at.desc,id.desc", "which is the order the page index stores");
  expectEqual(CATALOGUE_LIST_MAXIMUM_OFFSET, 2_000, "the offset cap is two thousand");
  expectEqual(CATALOGUE_LIST_PAGE_SIZE, 25, "a page is twenty five rows");
  expectEqual(CATALOGUE_LIST_PAGE_SIZE + 1, 26, "and asks for one more, which is how it knows there is a next page");

  // the two row schemas are one, because the select aliases the code column
  for (const kind of CATALOGUE_KINDS) {
    expect(
      catalogueListColumnsOf(kind).includes(`code:${CATALOGUE_CODE_COLUMN[kind]}`),
      `${kind}: the code column is aliased to code in the select`,
    );
  }

  expectEqual(
    catalogueListColumnsOf("product").length,
    catalogueListColumnsOf("service").length,
    "both catalogues read the same number of columns",
  );

  // the query a page runs is the exported one, and it is the same shape for both catalogues
  const sampleQuery = catalogueListQueryOf("product", COMPANY_A, parseCatalogueListQuery({ search: "lamp" }), 26);

  expect(sampleQuery.includes("company_id=eq."), "a page query is company scoped");
  expect(sampleQuery.includes("order=created_at.desc,id.desc"), "and ordered by the index");
  expect(sampleQuery.includes("limit=26") && sampleQuery.includes("offset=0"), "and windowed");
  expect(sampleQuery.includes("or=(name.ilike."), "and filtered when there is a search");

  // the row schema reads a bigint price through the one price schema
  expect(
    catalogueListRowSchema.parse({
      id: COMPANY_A,
      name: "Desk lamp",
      code: "LAMP-01",
      description: null,
      unit_price_minor: "425000",
      currency: "USD",
      unit: "item",
      created_at: new Date(NOW).toISOString(),
      updated_at: new Date(NOW).toISOString(),
    }).unit_price_minor === 425_000n,
    "the list row reads a bigint price as minor units",
  );

  // the removal marks rather than erases, which is what an invoice line needs
  const catalogueModule = await readRepositoryFile("services/products/catalogue.ts");

  expect(catalogueModule.includes("deleted_at: instant"), "the removal writes the marker, not a delete");
  expectEqual(/DELETE FROM|\bdelete\(/u.test(catalogueModule), false, "and never issues a row delete");
  expect(catalogueModule.includes("CATALOGUE_DELETED_AUDIT_ACTION"), "it writes an audit entry");

  // the two GET-only list routes are not on the protected list: a read has no token to check
  const csrf = await readRepositoryFile("lib/security/csrf.ts");

  expect(!csrf.includes('"/api/products/list"'), "the list read is not a protected path");
  expect(!csrf.includes('"/api/services/list"'), "for either catalogue");
  expect(csrf.includes('"/api/products/[id]"'), "while the route that answers DELETE is");

  // the screens: the list is the hub, and the removal sits on the edit screen only
  const screensSource = await readRepositoryFile("app/(dashboard)/products/catalogue-screens.tsx");

  expect(screensSource.includes("listCatalogueEntries"), "the hub reads the list through the service");
  expect(screensSource.includes("CatalogueListTable"), "and prints it as a table");
  expect(screensSource.includes("CatalogueSearchForm"), "with the search form");
  expect(screensSource.includes("DeleteCatalogueForm"), "the edit screen offers the removal");
  // The removal must sit in the edit screen's `ready` branch: the branch that renders an entry is the
  // only place a row is known, so a refusal prints no button to press.
  const editBranch = screensSource.slice(
    screensSource.indexOf('{state.kind === "ready" ? ('),
    screensSource.indexOf("{state.kind === \"ready\" ? (") + 900,
  );

  expect(editBranch.includes("<DeleteCatalogueForm"), "the removal is inside the branch that read a row");
  expect(
    screensSource.slice(0, screensSource.indexOf('{state.kind === "ready" ? (')).includes("<DeleteCatalogueForm") === false,
    "and is not offered outside it",
  );

  // the list gets the wider column, because six printed columns do not read in the form's width
  expect(screensSource.includes('"table"'), "the list asks for the table width");
  expect(screensSource.includes("max-w-5xl"), "which is wider than the forms");
  expect(
    (await readRepositoryFile("app/(dashboard)/products/catalogue-list-table.tsx")).includes("overflow-x-auto"),
    "and the table scrolls sideways rather than wrapping a row onto four lines",
  );

  const deleteForm = await readRepositoryFile("app/(dashboard)/products/delete-catalogue-form.tsx");

  expect(deleteForm.includes('method: "DELETE"'), "the removal sends DELETE");
  expect(deleteForm.includes("csrfHeaders("), "carrying the CSRF token");
  expect(!/window[.]confirm\s*\(/u.test(deleteForm), "with a confirmation in the page, not a browser dialog");
  expect(deleteForm.includes("setConfirming(true)"), "a first press asks");
  expect(deleteForm.includes("deleteFailed"), "and a refusal stays on the page");

  // the search form is a GET form, because a search changes nothing
  const searchForm = await readRepositoryFile("app/(dashboard)/products/catalogue-search-form.tsx");

  expect(searchForm.includes('method="get"') || searchForm.includes('method="GET"'), "the search form is a GET");
  expect(!searchForm.includes("csrfHeaders("), "so it carries no token");
  expect(!searchForm.includes('name="offset"'), "and starts a new question at the newest entry");

  // STEP 109 writes no migration either: the page indexes already exist
  for (const [path, index] of [
    ["migrations/0020_products.sql", "products_page_idx"],
    ["migrations/0021_services.sql", "services_page_idx"],
  ] as const) {
    const source = await readRepositoryFile(path);

    expect(source.includes(index), `${index} exists, which is why this STEP writes no migration`);
    expect(
      source.includes("(company_id, created_at desc, id desc)"),
      `${index} stores exactly the order the list reads`,
    );
  }
}

async function main(): Promise<void> {
  checkPrice();
  await checkCreate("product");
  await checkCreate("service");
  await checkValidation();
  await checkUniqueness("product");
  await checkUniqueness("service");
  await checkTenancy("product");
  await checkTenancy("service");
  await checkUpdate("product");
  await checkUpdate("service");
  await checkList("product");
  await checkList("service");
  await checkSearch("product");
  await checkSearch("service");
  await checkDelete("product");
  await checkDelete("service");
  await checkImportReport("product");
  await checkImportReport("service");
  await checkImportDefaults("product");
  await checkImportDefaults("service");
  await checkImportHeaders("product");
  await checkImportHeaders("service");
  await checkImportAgreement("product");
  await checkImportAgreement("service");
  await checkImportDuplicates("product");
  await checkImportDuplicates("service");
  await checkImportTenancy("product");
  await checkImportTenancy("service");
  await checkImportSources();
  await checkSources();

  if (failures.length > 0) {
    process.stderr.write(`catalogue gate failed with ${failures.length} problem(s):\n`);

    for (const failure of failures) {
      process.stderr.write(`  - ${failure}\n`);
    }

    process.exitCode = 1;

    return;
  }

  const kinds = CATALOGUE_KINDS.length;
  const fields = 6;
  const units = CATALOGUE_UNITS.length;
  const sample: CatalogueSnapshot["id"] = "018f2b8a-4444-4c2d-9c3e-000000000001";

  process.stdout.write(
    `catalogue gate passed: ${checks} checks, ${kinds} catalogues, ${fields} fields, ${units} units, ` +
      `${CATALOGUE_TABLES.product}/${CATALOGUE_TABLES.service}, sample ${sample.length} id characters\n`,
  );
}

await main();

// The row schema is exported for the routes; the gate reads it once so a broken schema fails here.
catalogueRowSchema.parse({
  id: "018f2b8a-4444-4c2d-9c3e-000000000001",
  company_id: COMPANY_A,
  name: "Desk lamp",
  sku: "LAMP-01",
  description: null,
  unit_price_minor: 425_000,
  currency: "USD",
  unit: "item",
  created_at: new Date(NOW).toISOString(),
  updated_at: new Date(NOW).toISOString(),
  deleted_at: null,
  version: 1,
});
