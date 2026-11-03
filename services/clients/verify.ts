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
import {
  CLIENT_LIST_MAXIMUM_OFFSET,
  CLIENT_LIST_PAGE_SIZE,
  CLIENT_SEARCH_FIELDS,
  CLIENT_SEARCH_MAXIMUM_LENGTH,
  CLIENT_SEARCH_PATTERN,
  clientListQueryOf,
  listClients,
  parseClientListQuery,
  type ClientListDependencies,
} from "./client-list.ts";

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

/**
 * The phrase an `or=(...)` search clause asks for, decoded the way PostgREST reads it.
 *
 * The fake refuses a clause set that names different phrases on different columns, which is the one
 * mistake a hand written query makes: a search that matched the name but not the email.
 */
function searchTermOf(clause: string): string {
  const inner = clause.startsWith("(") && clause.endsWith(")") ? clause.slice(1, -1) : clause;
  const terms = new Set<string>();

  for (const piece of inner.split(",")) {
    // PostgREST splits a filter at its first two dots and takes the rest as the value, so a term
    // carrying a dot - an email address, for instance - is one value and not three.
    const firstDot = piece.indexOf(".");
    const secondDot = piece.indexOf(".", firstDot + 1);
    const column = piece.slice(0, firstDot);
    const operator = piece.slice(firstDot + 1, secondDot);
    const value = secondDot === -1 ? undefined : piece.slice(secondDot + 1);

    if (operator !== "ilike" || value === undefined) {
      throw new Error(`the client list search is not a set of ilike clauses: ${piece}`);
    }

    if (!(CLIENT_SEARCH_FIELDS as readonly string[]).includes(column ?? "")) {
      throw new Error(`the client list searches a column it does not print: ${piece}`);
    }

    const decoded = decodeURIComponent(value);

    if (!decoded.startsWith("*") || !decoded.endsWith("*") || decoded.length < 2) {
      throw new Error(`the client list search is not a substring match: ${piece}`);
    }

    terms.add(decoded.slice(1, -1).toLowerCase());
  }

  if (terms.size !== 1) {
    throw new Error(`the client list searches different phrases per column: ${clause}`);
  }

  return [...terms][0] ?? "";
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

      // PostgREST answers an `or=(...)` of `ilike` clauses as one case insensitive substring test;
      // the fake does the same so a search that is not a phrase would show up here.
      const search = parts.get("or");

      if (search !== undefined) {
        const term = searchTermOf(search);

        matched = matched.filter((row) =>
          CLIENT_SEARCH_FIELDS.some(
            (field) => typeof row[field] === "string" && row[field].toLowerCase().includes(term),
          ),
        );
      }

      // A select names its columns; the fake keeps only those, which is what proves the list reads
      // the six facts it prints and not the notes and the address lines.
      const columns = parts.get("select");

      if (columns !== undefined) {
        const wanted = new Set(columns.split(","));
        matched = matched.map((row) => {
          const projected: Record<string, unknown> = {};

          for (const [key, value] of Object.entries(row)) {
            if (wanted.has(key)) {
              projected[key] = value;
            }
          }

          return projected;
        });
      }

      const ordered = [...matched].sort((left, right) => {
        const difference =
          Date.parse(String(right["created_at"])) - Date.parse(String(left["created_at"]));

        return difference !== 0 ? difference : String(right["id"]).localeCompare(String(left["id"]));
      });
      const offset = Number.parseInt(parts.get("offset") ?? "0", 10);
      const limit = Number.parseInt(parts.get("limit") ?? String(ordered.length), 10);
      const page = ordered.slice(offset, Number.isFinite(limit) ? offset + limit : undefined);

      return Promise.resolve(page.map((row) => schema.parse(row)));
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

function listDepsOf(db: ClientsDb): ClientListDependencies {
  return { rest: createClientsRest(db), now: () => NOW };
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

/* ---- the paginated list with search of STEP 107 ---- */

/** One client body with a distinct name, so a page can be told apart row by row. */
function clientBody(index: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: `Client ${String(index).padStart(2, "0")}`,
    company_name: index % 2 === 0 ? "Rahman Trading" : "Lake View Studio",
    email: `client${String(index)}@example.com`,
    phone: `+880171100${String(1_000 + index).slice(-4)}`,
    address_line1: `${String(10 + index)} Lake View Road`,
    city: "Dhaka",
    country: "BD",
    ...overrides,
  };
}

/** A database holding `count` clients of company A, plus one of company B and one deleted row. */
async function seededListDb(count: number): Promise<ClientsDb> {
  const db: ClientsDb = { rows: [], inserts: [], updates: [], queries: [] };
  const dependencies = depsOf(db);

  for (let index = 1; index <= count; index += 1) {
    await createClient({ actor: owner, body: clientBody(index) }, dependencies);
  }

  const live = at(db.rows, 0, "the first seeded row");
  db.rows.push({ ...live, id: randomUUID(), company_id: COMPANY_B, name: "Another Merchant Client" });
  db.rows.push({
    ...live,
    id: randomUUID(),
    name: "Deleted Client",
    email: "deleted@example.com",
    deleted_at: new Date(NOW).toISOString(),
  });

  return db;
}

async function checkListPaging(): Promise<void> {
  const db = await seededListDb(CLIENT_LIST_PAGE_SIZE * 2 + 5);

  const first = await listClients(
    { actor: owner, query: parseClientListQuery({}) },
    listDepsOf(db),
  );

  expectEqual(first.clients.length, CLIENT_LIST_PAGE_SIZE, "a page holds the page size");
  expectEqual(first.offset, 0, "an empty query starts at the first row");
  expectEqual(first.pageNumber, 1, "and is the first page");
  expectEqual(first.previousOffset, null, "there is nothing newer than the first page");
  expectEqual(first.nextOffset, CLIENT_LIST_PAGE_SIZE, "and a next page because more rows exist");
  expectEqual(first.search, null, "no search is applied");
  expectEqual(first.pageSize, CLIENT_LIST_PAGE_SIZE, "the page names its own size");
  expectEqual(first.readAtEpochMs, NOW, "the read instant comes from the injected clock");
  expect(
    db.queries.every((query) => query.includes(`company_id=eq.${COMPANY_A}`)),
    "every list query is scoped to the actor's company",
  );
  expect(
    first.clients.every((client) => client.name !== "Another Merchant Client"),
    "another merchant's client is never on the page",
  );
  expect(
    first.clients.every((client) => client.name !== "Deleted Client"),
    "a soft deleted client is never on the page",
  );

  // newest first, and the tie is broken by the id so two pages never overlap
  const created = first.clients.map((client) => client.createdAtEpochMs);
  expect(
    created.every((value, index) => index === 0 || (created[index - 1] ?? 0) >= value),
    "the page is newest first",
  );

  const second = await listClients(
    { actor: owner, query: parseClientListQuery({ offset: String(CLIENT_LIST_PAGE_SIZE) }) },
    listDepsOf(db),
  );
  expectEqual(second.pageNumber, 2, "the second page is page two");
  expectEqual(second.previousOffset, 0, "with a newer page behind it");
  expectEqual(second.nextOffset, CLIENT_LIST_PAGE_SIZE * 2, "and a third page ahead");
  expectEqual(
    second.clients.filter((client) => first.clients.some((other) => other.id === client.id)).length,
    0,
    "no row appears on two pages",
  );

  const third = await listClients(
    { actor: owner, query: parseClientListQuery({ offset: String(CLIENT_LIST_PAGE_SIZE * 2) }) },
    listDepsOf(db),
  );
  expectEqual(third.clients.length, 5, "the last page holds the remainder");
  expectEqual(third.nextOffset, null, "and there is no page after it");

  // the query the page builds names its columns, the tenant, the live rows, the order and the window
  const query = clientListQueryOf(COMPANY_A, parseClientListQuery({ offset: "50" }), 26);
  expect(query.includes("select=id,name,company_name,email,phone,city,created_at,updated_at"), "the page selects only the columns it prints");
  expect(query.includes("order=created_at.desc,id.desc"), "and orders them the way 0019 indexes them");
  expect(query.includes("limit=26"), "asking for one row more than it shows");
  expect(query.includes("offset=50"), "at the offset it read");
  expectEqual(query.includes("notes"), false, "the notes never leave the database for a list");
  expectEqual(query.includes("tax_id"), false, "and neither does the tax identifier");
  expectEqual(query.includes("address_line1"), false, "or the street line");

  // the offset is a grid position inside the cap, and a hand-edited one is reported
  expectEqual(parseClientListQuery({ offset: "30" }).offset, CLIENT_LIST_PAGE_SIZE, "an offset lands on the page that holds it");
  expectEqual(parseClientListQuery({ offset: "999999999" }).offset, CLIENT_LIST_MAXIMUM_OFFSET, "an offset past the cap is clamped to it");
  expectDeepEqual(parseClientListQuery({ offset: "-1" }).problems, [{ field: "offset", rule: "invalid_format" }], "a negative offset is refused");
  expectDeepEqual(parseClientListQuery({ offset: "2;drop" }).problems, [{ field: "offset", rule: "invalid_format" }], "an offset that is not digits is refused");
}

async function checkListSearch(): Promise<void> {
  const db = await seededListDb(CLIENT_LIST_PAGE_SIZE + 3);

  const byName = await listClients(
    { actor: owner, query: parseClientListQuery({ search: "client 05" }) },
    listDepsOf(db),
  );
  expectEqual(byName.search, "client 05", "the search phrase is answered back for the screen");
  expectEqual(byName.clients.length, 1, "one client matches the phrase");
  expectEqual(byName.clients[0]?.name, "Client 05", "and it is the one typed");

  // case insensitively, and against the company name rather than the person
  const byCompany = await listClients(
    { actor: owner, query: parseClientListQuery({ search: "LAKE VIEW" }) },
    listDepsOf(db),
  );
  expect(byCompany.clients.length > 0, "the company name is searched case insensitively");
  expect(
    byCompany.clients.every((client) => client.companyName === "Lake View Studio"),
    "and every match is the company asked for",
  );

  // the email and the phone are searched too
  const byEmail = await listClients(
    { actor: owner, query: parseClientListQuery({ search: "client7@example.com" }) },
    listDepsOf(db),
  );
  expectEqual(byEmail.clients.length, 1, "the email is searched");
  const byPhone = await listClients(
    { actor: owner, query: parseClientListQuery({ search: "1711" }) },
    listDepsOf(db),
  );
  expectEqual(byPhone.clients.length, CLIENT_LIST_PAGE_SIZE, "the phone is searched and the whole book matches");
  expect(
    byPhone.clients.every((client) => client.phone !== null && client.phone.includes("1711")),
    "and every match carries the digits typed",
  );

  const noMatch = await listClients(
    { actor: owner, query: parseClientListQuery({ search: "nobody" }) },
    listDepsOf(db),
  );
  expectEqual(noMatch.clients.length, 0, "a phrase nobody matches answers an empty page");
  expectEqual(noMatch.nextOffset, null, "with no page after it");

  // the term is sanitised before it is measured, and refused rather than rewritten
  expectEqual(parseClientListQuery({ search: "   " }).filters.search, null, "a blank search is no search");
  expectEqual(parseClientListQuery({ search: "  Amina  Rahman " }).filters.search, "Amina Rahman", "the term is collapsed to one line");
  expectDeepEqual(
    parseClientListQuery({ search: "a,b" }).problems,
    [{ field: "search", rule: "invalid_format" }],
    "a comma is refused, because PostgREST reads it as structure",
  );

  for (const hostile of ["x*", "a)", "(a", 'a"', "a\\", "a:b", "a%", "a(b)"]) {
    const parsed = parseClientListQuery({ search: hostile });
    expectEqual(parsed.filters.search, null, `the term ${hostile} never reaches a filter`);
    expectEqual(parsed.problems.length, 1, `and ${hostile} is reported rather than dropped silently`);
  }

  expectDeepEqual(
    parseClientListQuery({ search: "x".repeat(CLIENT_SEARCH_MAXIMUM_LENGTH + 1) }).problems,
    [{ field: "search", rule: "too_long" }],
    "an over long search is refused, not truncated",
  );
  expectEqual(
    parseClientListQuery({ search: "x".repeat(CLIENT_SEARCH_MAXIMUM_LENGTH) }).filters.search?.length,
    CLIENT_SEARCH_MAXIMUM_LENGTH,
    "a search at the ceiling is accepted",
  );
  expect(CLIENT_SEARCH_PATTERN.test("Jose Alvarez-Nunez"), "a hyphenated name is a legal search");
  expect(CLIENT_SEARCH_PATTERN.test("o'brien"), "and an apostrophe is");
  expect(CLIENT_SEARCH_PATTERN.test("accounts@example.com"), "and an email address is");
  expectEqual(CLIENT_SEARCH_PATTERN.test("a,b"), false, "a comma is not a legal search");
}

async function checkListTenancy(): Promise<void> {
  const db = await seededListDb(3);

  // another merchant sees their own book, which holds the one row seeded for company B
  const foreign = await listClients(
    { actor: otherOwner, query: parseClientListQuery({}) },
    listDepsOf(db),
  );
  expectEqual(foreign.clients.length, 1, "another merchant sees only their own client");
  expectEqual(foreign.clients[0]?.name, "Another Merchant Client", "which is the row of their company");

  // the same phrase against the other merchant finds nothing of company A
  const foreignSearch = await listClients(
    { actor: otherOwner, query: parseClientListQuery({ search: "Client 01" }) },
    listDepsOf(db),
  );
  expectEqual(foreignSearch.clients.length, 0, "and a search cannot reach across the tenant");

  for (const roles of [["compliance_kyc"], ["support"], ["finance_ops"], ["ceo"], ["super_admin"], ["blogger"]] as const) {
    const refused = await rejectionOf(() =>
      listClients(
        { actor: actorOf([...roles], COMPANY_A, { userId: OFFICE_ID }), query: parseClientListQuery({}) },
        listDepsOf(db),
      ),
    );
    expect(isAppError(refused) && refused.code === "PERMISSION_DENIED", `the role ${roles[0]} may not list clients`);
  }

  const platformAccount = await rejectionOf(() =>
    listClients({ actor: desk, query: parseClientListQuery({}) }, listDepsOf(db)),
  );
  expect(isAppError(platformAccount) && platformAccount.code === "PERMISSION_DENIED", "a platform account with no company is refused");

  // a deleted row is invisible to a search that names it
  const deleted = await listClients(
    { actor: owner, query: parseClientListQuery({ search: "deleted" }) },
    listDepsOf(db),
  );
  expectEqual(deleted.clients.length, 0, "a soft deleted client is not findable");
}

async function checkListSources(): Promise<void> {
  const listSource = await readRepositoryFile("services/clients/client-list.ts");
  const service = await readRepositoryFile("services/clients/clients.ts");
  const route = await readRepositoryFile("app/api/clients/list/route.ts");
  const screen = await readRepositoryFile("app/(dashboard)/clients/page.tsx");
  const form = await readRepositoryFile("app/(dashboard)/clients/client-search-form.tsx");

  expect(listSource.includes('from "zod"'), "the list validates its rows with zod");
  expect(listSource.includes("company_id=eq."), "and scopes every query to one company");
  expect(listSource.includes("deleted_at=is.null"), "skipping deleted rows");
  expect(listSource.includes("sanitizeSingleLineText"), "the search term is sanitised before it is used");
  expect(listSource.includes("encodeURIComponent(`*${term}*`)"), "the term is escaped into the filter");
  expect(listSource.includes("CLIENT_MANAGE_ROLES"), "the list uses the owner role list of the service");
  expect(service.includes("export const CLIENT_MANAGE_ROLES"), "which the service exports");

  expect(route.includes("export const GET"), "the list route answers GET");
  expect(!/export const (POST|PUT|PATCH|DELETE)/u.test(route), "and no mutation, so it needs no token");
  expectEqual(route.split("requireCsrfToken(").length - 1, 0, "the read route never asks for a token");
  expect(route.includes("readRequestActor"), "the account comes from the cookie");
  expect(route.includes('"cache-control": "no-store"'), "and the answer is never cached");
  expect(route.includes("parseClientListQuery"), "the route reads the query through the parser");

  // the screen does not restate the rule and the form does not restate the alphabet
  expect(screen.includes("listClients("), "the screen calls the service");
  expectEqual(screen.includes("requireAnyRole"), false, "and states no role of its own");
  expectEqual(screen.includes("CLIENT_MANAGE_ROLES"), false, "restating neither the role list");
  expect(form.includes("ClientListProblem"), "the form renders the service's problems");
  expectEqual(/\[a-z0-9\]/u.test(form), false, "the form carries no pattern of its own");

  // the catalog carries every key the two files use
  const catalog = await readRepositoryFile("lib/i18n/strings/en.ts");
  const keys = new Set<string>();

  for (const source of [screen, form]) {
    for (const match of source.matchAll(/"(clients\.[a-zA-Z0-9]+)"/gu)) {
      const key = match[1];

      if (key !== undefined) {
        keys.add(key);
      }
    }
  }

  expect(keys.size > 0, "the list screens use catalog keys");

  for (const key of keys) {
    const leaf = key.slice("clients.".length);
    expect(catalog.includes(`${leaf}:`), `the catalog carries ${key}`);
  }
}

async function checkSources(): Promise<void> {
  const paths = [
    "services/clients/client-fields.ts",
    "services/clients/clients.ts",
    "services/clients/verify.ts",
    "app/api/clients/route.ts",
    "app/api/clients/[id]/route.ts",
    "services/clients/client-list.ts",
    "app/api/clients/list/route.ts",
    "app/(dashboard)/clients/page.tsx",
    "app/(dashboard)/clients/client-search-form.tsx",
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
  await checkListPaging();
  await checkListSearch();
  await checkListTenancy();
  await checkListSources();
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
    `clients gate passed: ${checks} checks, ${CLIENT_FIELDS.length} fields, ` +
      `${CLIENT_LIST_PAGE_SIZE} per page, table "${CLIENTS_TABLE}"\n`,
  );
}

await main();
