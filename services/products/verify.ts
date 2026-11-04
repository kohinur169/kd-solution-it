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
  CATALOGUE_MANAGE_ROLES,
  CATALOGUE_RULES,
  CATALOGUE_UPDATED_AUDIT_ACTION,
  catalogueRowSchema,
  createCatalogueEntry,
  getCatalogueEntry,
  updateCatalogueEntry,
  type CatalogueDependencies,
  type CatalogueSnapshot,
} from "./catalogue.ts";
import {
  CATALOGUE_CODE_COLUMN,
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

      return Promise.resolve(matched.map((row) => schema.parse(row)));
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

  for (const routePath of ["app/api/products/route.ts", "app/api/products/[id]/route.ts", "app/api/services/route.ts", "app/api/services/[id]/route.ts"]) {
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
