// path: services/clients/verify.ts
import process from "node:process";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { z } from "zod";
import { createInMemoryAuditTrail, type AuditTrail } from "../../lib/auth/audit.ts";
import type { RestClient } from "../../lib/auth/rest.ts";
import type { PlatformRole, RequestActor } from "../../lib/auth/types.ts";
import { AppError, isAppError } from "../../lib/errors/app-error.ts";
import {
  CLIENT_CREATED_AUDIT_ACTION,
  CLIENT_UPDATED_AUDIT_ACTION,
  CLIENTS_TABLE,
  createClient,
  getClient,
  updateClient,
  type ClientDependencies,
} from "./clients.ts";
import { CLIENT_FIELDS, CLIENT_FIELD_LIMITS } from "./client-fields.ts";

/**
 * Client service gate. Run with `node services/clients/verify.ts`.
 *
 * The gate drives the real service over an in-memory PostgREST of the `0019` clients table, so
 * what passes here is the code the routes run:
 *
 *   1. every field rule of the `0019` checks is enforced by the Zod schema, and a refusal lists
 *      every broken field with its rule, mapped for the form;
 *   2. the address completeness rule needs the street line once any other address field is set -
 *      on create and on the merged row of an edit;
 *   3. an email already used by the same merchant (case insensitively) answers CONFLICT naming the
 *      email field, and another merchant may use the same address;
 *   4. every read and update is scoped to the actor's company, and a foreign or deleted row is a
 *      404; only the owner role may act;
 *   5. the routes are POST-only, check the CSRF token exactly once before reading the body, and are
 *      on the protected list; the catalog carries the `clients` section; the field ceilings mirror
 *      the migration.
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

function expectEqual<T>(actual: T, expected: T, description: string): void {
  checks += 1;

  if (actual !== expected) {
    failures.push(`${description} (expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)})`);
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

/** Indexed access into a fixture array, loud when the fixture is shorter than the test assumed. */
function at<T>(items: readonly T[], index: number, description: string): T {
  const item = items[index];

  if (item === undefined) {
    throw new Error(`gate fixture: ${description} is missing at index ${index}`);
  }

  return item;
}

const NOW = Date.parse("2026-11-03T10:00:00.000Z");

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

/* ---- an in-memory clients table shaped like 0019 ---- */

interface ClientsDb {
  rows: Array<Record<string, unknown>>;
  inserts: Array<Record<string, unknown>>;
  updates: Array<{ readonly query: string; readonly values: Record<string, unknown> }>;
  queries: string[];
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

function createClientsRest(db: ClientsDb): RestClient {
  return {
    select<TRow>(table: string, query: string, schema: z.ZodType<TRow>): Promise<readonly TRow[]> {
      db.queries.push(`${table}?${query}`);

      if (table !== CLIENTS_TABLE) {
        return Promise.reject(new Error(`the client service reads no table but clients: ${table}`));
      }

      const parts = queryParts(query);
      const company = parts.get("company_id");

      if (company === undefined || !company.startsWith("eq.")) {
        return Promise.reject(new Error(`a clients read is not scoped to one company: ${query}`));
      }

      const companyId = company.slice(3);
      const id = parts.get("id");
      const liveOnly = parts.get("deleted_at") === "is.null";

      let matched = db.rows.filter((row) => row["company_id"] === companyId);

      if (id !== undefined && id.startsWith("eq.")) {
        matched = matched.filter((row) => row["id"] === id.slice(3));
      }

      if (liveOnly) {
        matched = matched.filter((row) => row["deleted_at"] === null);
      }

      return Promise.resolve(matched.map((row) => schema.parse(row)));
    },
    insert(): Promise<never> {
      return Promise.reject(new Error("the client service inserts with return=representation only"));
    },
    insertReturning<TRow>(
      table: string,
      rows: readonly Readonly<Record<string, unknown>>[],
      schema: z.ZodType<TRow>,
    ): Promise<readonly TRow[]> {
      if (table !== CLIENTS_TABLE) {
        return Promise.reject(new Error(`the client service inserts into no table but clients: ${table}`));
      }

      for (const row of rows) {
        db.inserts.push({ ...row });

        const email = typeof row["email"] === "string" ? row["email"].toLowerCase() : null;

        if (
          email !== null &&
          db.rows.some(
            (existing) =>
              existing["company_id"] === row["company_id"] &&
              existing["deleted_at"] === null &&
              typeof existing["email"] === "string" &&
              existing["email"].toLowerCase() === email,
          )
        ) {
          return Promise.reject(new AppError("CONFLICT", { cause: { code: "23505" } }));
        }

        const createdAt = new Date(NOW + db.rows.length).toISOString();
        const stored = {
          id: randomUUID(),
          deleted_at: null,
          version: 1,
          created_at: createdAt,
          updated_at: createdAt,
          ...row,
        };

        db.rows.push(stored);

        return Promise.resolve([schema.parse(stored)]);
      }

      return Promise.reject(new Error("insertReturning needs one row"));
    },
    update(table: string, query: string, values: Readonly<Record<string, unknown>>): Promise<void> {
      db.updates.push({ query, values: { ...values } });

      if (table !== CLIENTS_TABLE) {
        return Promise.reject(new Error(`the client service updates no table but clients: ${table}`));
      }

      const parts = queryParts(query);
      const company = parts.get("company_id");
      const id = parts.get("id");

      if (company === undefined || !company.startsWith("eq.") || id === undefined || !id.startsWith("eq.")) {
        return Promise.reject(new Error(`a clients update is not scoped to one row of one company: ${query}`));
      }

      const row = db.rows.find(
        (candidate) =>
          candidate["id"] === id.slice(3) &&
          candidate["company_id"] === company.slice(3) &&
          (parts.get("deleted_at") !== "is.null" || candidate["deleted_at"] === null),
      );

      // PostgREST reports success when nothing matched; the service re-reads for that reason.
      if (row !== undefined) {
        Object.assign(row, values, { updated_at: new Date(NOW + db.rows.length + 1_000).toISOString(), version: Number(row["version"]) + 1 });
      }

      return Promise.resolve();
    },
    rpc(): Promise<never> {
      return Promise.reject(new Error("the client service calls no rpc"));
    },
  };
}

function depsOf(db: ClientsDb, audit: AuditTrail = createInMemoryAuditTrail()): ClientDependencies & { readonly audit: AuditTrail } {
  return { rest: createClientsRest(db), audit, now: () => NOW };
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
  if (isAppError(error)) {
    return error.details;
  }

  return [];
}

const VALID_BODY = {
  name: "Amina Rahman",
  company_name: "Rahman Trading",
  email: "amina@example.com",
  phone: "+880 1711-000000",
  address_line1: "12 Lake View Road",
  address_line2: "Suite 4",
  city: "Dhaka",
  region: "Dhaka Division",
  postal_code: "1207",
  country: "BD",
  tax_id: "TIN-1234567",
  notes: "Prefers invoices by email.",
};

async function checkCreate(): Promise<void> {
  const db: ClientsDb = { rows: [], inserts: [], updates: [], queries: [] };
  const audit = createInMemoryAuditTrail();
  const dependencies = depsOf(db, audit);

  const created = await createClient({ actor: owner, body: VALID_BODY }, dependencies);

  expectEqual(created.companyId, COMPANY_A, "the snapshot names the actor's company");
  expectEqual(created.values.name, "Amina Rahman", "the name");
  expectEqual(created.values.country, "BD", "the country");
  expectEqual(db.inserts.length, 1, "one row inserted");
  expectEqual(db.inserts[0]?.["company_id"], COMPANY_A, "scoped to the actor's company");
  expectEqual(audit.entries.length, 1, "one audit entry");
  expectEqual(audit.entries[0]?.action, CLIENT_CREATED_AUDIT_ACTION, "as client.created");
  expectEqual(audit.entries[0]?.entityType, "client", "against the client entity");
  expectEqual(audit.entries[0]?.entityId, created.id, "naming the row");
  expectEqual(audit.entries[0]?.companyId, COMPANY_A, "and the company");
  expectEqual(audit.entries[0]?.actorUserId, OWNER_ID, "and the actor");
  expect(
    JSON.stringify(audit.entries[0]?.payload).includes("name") &&
      !JSON.stringify(audit.entries[0]?.payload).includes("amina@example.com"),
    "the audit names the fields written, never the values",
  );

  // the same email again, in another case, is a conflict naming the field
  const duplicate = await rejectionOf(() =>
    createClient({ actor: owner, body: { ...VALID_BODY, email: "AMINA@example.com" } }, dependencies),
  );
  expect(isAppError(duplicate) && duplicate.code === "CONFLICT", "a duplicate email answers CONFLICT");
  expectDeepEqual(detailsOf(duplicate), [{ field: "email", rule: "already_used" }], "naming the email field");

  // another merchant may hold the same address
  const other = await createClient({ actor: otherOwner, body: VALID_BODY }, depsOf({ ...db, rows: db.rows }, createInMemoryAuditTrail()));
  expectEqual(other.companyId, COMPANY_B, "another merchant can hold the same person");
}

async function checkValidation(): Promise<void> {
  const db: ClientsDb = { rows: [], inserts: [], updates: [], queries: [] };
  const dependencies = depsOf(db);

  async function refusal(body: unknown): Promise<unknown> {
    return rejectionOf(() => createClient({ actor: owner, body }, dependencies));
  }

  expectEqual(db.inserts.length, 0, "nothing inserted yet");

  const cases: Array<[string, unknown, string, string]> = [
    ["an empty name", { ...VALID_BODY, name: "   " }, "name", "required"],
    ["a long name", { ...VALID_BODY, name: "x".repeat(121) }, "name", "too_long"],
    ["a long company name", { ...VALID_BODY, company_name: "x".repeat(161) }, "company_name", "too_long"],
    ["a malformed email", { ...VALID_BODY, email: "not-an-email" }, "email", "invalid_format"],
    ["a long email", { ...VALID_BODY, email: `${"a".repeat(250)}@example.com` }, "email", "too_long"],
    ["a malformed phone", { ...VALID_BODY, phone: "call me" }, "phone", "invalid_format"],
    ["a malformed postal code", { ...VALID_BODY, postal_code: "ab" }, "postal_code", "invalid_format"],
    ["a lowercase country", { ...VALID_BODY, country: "bd" }, "country", "invalid_format"],
    ["a long tax id", { ...VALID_BODY, tax_id: "x".repeat(33) }, "tax_id", "too_long"],
    ["long notes", { ...VALID_BODY, notes: "x".repeat(2_001) }, "notes", "too_long"],
    ["a city without a street line", { name: "Amina", city: "Dhaka" }, "address_line1", "address_requires_line1"],
    ["a postal code without a street line", { name: "Amina", postal_code: "1207" }, "address_line1", "address_requires_line1"],
    ["an unknown key", { ...VALID_BODY, nickname: "Amy" }, "nickname", "unknown_field"],
  ];

  for (const [description, body, field, rule] of cases) {
    const error = await refusal(body);
    expect(isAppError(error) && error.code === "VALIDATION_FAILED", `${description} is a validation failure`);
    expectDeepEqual(detailsOf(error), [{ field, rule }], `${description} names ${field} with rule ${rule}`);
  }

  const notObject = await refusal("a string");
  expect(isAppError(notObject) && notObject.code === "VALIDATION_FAILED", "a non-object body is a validation failure");

  // several broken fields are listed in one answer, and the address rule joins in because a
  // country was sent without a street line
  const many = await refusal({ name: "", email: "nope", country: "zzz" });
  const fields = detailsOf(many).map((detail) => detail.field);
  expectDeepEqual(fields, ["name", "email", "country", "address_line1"], "every broken field is listed at once");

  // control characters are sanitised away before the rule runs
  const cleaned = await createClient({ actor: owner, body: { name: "Amina\u0007Rahman" } }, depsOf(db));
  expectEqual(cleaned.values.name, "AminaRahman", "the sanitiser removed the control character");

  // optional fields left empty become null columns
  const sparse = await createClient({ actor: owner, body: { name: "Solo", email: "" } }, depsOf(db));
  expectEqual(sparse.values.email, null, "an empty optional field is stored as null");

  expectEqual(db.inserts.length, 2, "only the two valid creates inserted");
}

async function checkReadAndUpdate(): Promise<void> {
  const db: ClientsDb = { rows: [], inserts: [], updates: [], queries: [] };
  const audit = createInMemoryAuditTrail();
  const dependencies = depsOf(db, audit);

  const created = await createClient({ actor: owner, body: VALID_BODY }, dependencies);

  const read = await getClient({ actor: owner, clientId: created.id }, dependencies);
  expectEqual(read.id, created.id, "the owner reads the client");
  expect(db.queries.every((query) => query.includes(`company_id=eq.${COMPANY_A}`)), "every query is company scoped");

  const foreign = await rejectionOf(() => getClient({ actor: otherOwner, clientId: created.id }, dependencies));
  expect(isAppError(foreign) && foreign.code === "RESOURCE_NOT_FOUND", "another merchant gets a 404, not the row");

  const badId = await rejectionOf(() => getClient({ actor: owner, clientId: "not-a-uuid" }, dependencies));
  expect(isAppError(badId) && badId.code === "VALIDATION_FAILED", "a malformed id is a 422");

  const missing = await rejectionOf(() => getClient({ actor: owner, clientId: randomUUID() }, dependencies));
  expect(isAppError(missing) && missing.code === "RESOURCE_NOT_FOUND", "an unknown id is a 404");

  const roleDenied = await rejectionOf(() => getClient({ actor: desk, clientId: created.id }, dependencies));
  expect(isAppError(roleDenied) && roleDenied.code === "PERMISSION_DENIED", "a non-owner role is refused");

  // a soft deleted row is not live
  at(db.rows, 0, "the seeded row")["deleted_at"] = new Date(NOW).toISOString();
  const deleted = await rejectionOf(() => getClient({ actor: owner, clientId: created.id }, dependencies));
  expect(isAppError(deleted) && deleted.code === "RESOURCE_NOT_FOUND", "a deleted client is a 404");
  at(db.rows, 0, "the seeded row")["deleted_at"] = null;

  // an edit changes only the fields it sends
  const updatesBefore = db.updates.length;
  const updated = await updateClient(
    { actor: owner, clientId: created.id, body: { city: "Chattogram", notes: "" } },
    dependencies,
  );
  expectEqual(updated.values.city, "Chattogram", "the sent field changed");
  expectEqual(updated.values.notes, null, "a cleared field is stored as null");
  expectEqual(updated.values.name, VALID_BODY.name, "an unsent field keeps its value");
  expectEqual(db.updates.length, updatesBefore + 1, "one update ran");
  const lastUpdate = at(db.updates, db.updates.length - 1, "the last update");
  expect(lastUpdate.query.includes(`company_id=eq.${COMPANY_A}`), "the update is company scoped");
  expectDeepEqual(Object.keys(lastUpdate.values).sort(), ["city", "notes"], "only the sent fields were written");
  expectEqual(audit.entries[audit.entries.length - 1]?.action, CLIENT_UPDATED_AUDIT_ACTION, "audited as client.updated");
  expectDeepEqual((audit.entries[audit.entries.length - 1]?.payload as { fields: string[] }).fields.sort(), ["city", "notes"], "naming the changed fields");

  // clearing the street line while a city is stored is refused on the merged row
  const badMerge = await rejectionOf(() =>
    updateClient({ actor: owner, clientId: created.id, body: { address_line1: "" } }, dependencies),
  );
  expect(isAppError(badMerge) && badMerge.code === "VALIDATION_FAILED", "clearing line1 with a city stored is refused");
  expectDeepEqual(detailsOf(badMerge), [{ field: "address_line1", rule: "address_requires_line1" }], "with the address rule");

  // an edit of another merchant's row is a 404
  const foreignUpdate = await rejectionOf(() =>
    updateClient({ actor: otherOwner, clientId: created.id, body: { name: "Nope" } }, dependencies),
  );
  expect(isAppError(foreignUpdate) && foreignUpdate.code === "RESOURCE_NOT_FOUND", "a foreign edit is a 404");
}

async function checkSources(): Promise<void> {
  const paths = [
    "services/clients/client-fields.ts",
    "services/clients/clients.ts",
    "services/clients/verify.ts",
    "app/api/clients/route.ts",
    "app/api/clients/[id]/route.ts",
    "app/(dashboard)/clients/page.tsx",
    "app/(dashboard)/clients/new/page.tsx",
    "app/(dashboard)/clients/[id]/page.tsx",
    "app/(dashboard)/clients/client-form.tsx",
  ];

  for (const path of paths) {
    const source = await readRepositoryFile(path);
    expect(source.length > 0, `${path} exists`);
    expect(!/[^\u0009\u000a\u000d\u0020-\u007e]/u.test(source), `${path} is ASCII only`);
    expect(source.split("\n", 1)[0]?.trim() === `// path: ${path}`, `${path} starts with its path comment`);
  }

  for (const path of paths.filter((path) => !path.endsWith("verify.ts"))) {
    const source = await readRepositoryFile(path);
    expect(!/console\.log\(/u.test(source), `${path} never writes to the console`);
  }

  // the routes are POST-only mutations with the token checked once, before the body
  const createRoute = await readRepositoryFile("app/api/clients/route.ts");
  expect(createRoute.includes("export const POST"), "the create route answers POST");
  expect(!/export const (PUT|PATCH|DELETE)/u.test(createRoute), "the create route answers no other mutation");
  expectEqual(createRoute.split("requireCsrfToken(").length - 1, 1, "the create route checks the token exactly once");
  expect(
    createRoute.indexOf("requireCsrfToken(") < createRoute.indexOf("request.text()"),
    "the create route checks the token before reading the body",
  );

  const editRoute = await readRepositoryFile("app/api/clients/[id]/route.ts");
  expect(editRoute.includes("export const POST") && editRoute.includes("export const GET"), "the edit route answers GET and POST");
  expect(!/export const (PUT|PATCH|DELETE)/u.test(editRoute), "the edit route answers no other mutation");
  expectEqual(editRoute.split("requireCsrfToken(").length - 1, 1, "the edit route checks the token exactly once");
  expect(
    editRoute.indexOf("requireCsrfToken(") < editRoute.indexOf("request.text()"),
    "the edit route checks the token before reading the body",
  );

  const csrfList = await readRepositoryFile("lib/security/csrf.ts");
  expect(csrfList.includes('"/api/clients"'), "the create route is on the csrf protected list");
  expect(csrfList.includes('"/api/clients/[id]"'), "the edit route is on the csrf protected list");

  // the service validates with zod and scopes every query
  const service = await readRepositoryFile("services/clients/clients.ts");
  expect(service.includes("from \"zod\""), "the service validates with zod");
  expect(service.includes("company_id=eq."), "every query is company scoped");
  expect(service.includes("requireCompanyId"), "the company comes from the actor");
  expect(service.includes("insertReturning"), "the insert reads the row back");
  expect(service.includes("deleted_at=is.null"), "live reads skip deleted rows");

  // the field ceilings mirror the migration checks
  const migration = await readRepositoryFile("migrations/0019_clients.sql");
  for (const field of CLIENT_FIELDS) {
    const limit = CLIENT_FIELD_LIMITS[field];
    expect(migration.includes(`${field}_check`), `the migration has a check for ${field}`);
    expect(migration.includes(`between 1 and ${limit.max}`) || migration.includes(`${limit.max}`), `the migration names the ceiling of ${field}`);
  }

  // the catalog carries the clients section and every key the form uses
  const catalog = await readRepositoryFile("lib/i18n/strings/en.ts");
  expect(catalog.includes("clients: {"), "the catalog has a clients section");
  const form = await readRepositoryFile("app/(dashboard)/clients/client-form.tsx");
  const usedKeys = [...form.matchAll(/"(clients\.[a-zA-Z]+)"/gu)].map((match) => match[1] as string);
  expect(usedKeys.length > 0, "the form uses catalog keys");
  for (const key of new Set(usedKeys)) {
    const leaf = key.slice("clients.".length);
    expect(catalog.includes(`${leaf}:`), `the catalog carries ${key}`);
  }
}

async function main(): Promise<void> {
  await checkCreate();
  await checkValidation();
  await checkReadAndUpdate();
  await checkSources();

  if (failures.length > 0) {
    process.stderr.write(`clients gate failed with ${failures.length} problem(s):\n`);

    for (const failure of failures) {
      process.stderr.write(`  - ${failure}\n`);
    }

    process.exitCode = 1;

    return;
  }

  process.stdout.write(
    `clients gate passed: ${checks} checks, ${CLIENT_FIELDS.length} fields, table "${CLIENTS_TABLE}"\n`,
  );
}

await main();
