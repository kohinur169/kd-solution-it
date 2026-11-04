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
  CLIENT_DELETED_AUDIT_ACTION,
  CLIENT_UPDATED_AUDIT_ACTION,
  CLIENTS_TABLE,
  createClient,
  deleteClient,
  getClient,
  updateClient,
  type ClientDependencies,
} from "./clients.ts";
import { CLIENT_FIELDS, CLIENT_FIELD_LIMITS } from "./client-fields.ts";
import { importClients } from "./client-import.ts";
import {
  MAXIMUM_CSV_CHARACTERS,
  MAXIMUM_CSV_ROWS,
  normaliseHeader,
  readCsv,
} from "./csv.ts";
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

/** An empty book, which is how each check starts. */
function createDb(): ClientsDb {
  return { rows: [], inserts: [], updates: [], queries: [] };
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

/* ---- the removal of one client, the third verb of section 15 line 163 ---- */

async function checkDelete(): Promise<void> {
  const db: ClientsDb = { rows: [], inserts: [], updates: [], queries: [] };
  const audit = createInMemoryAuditTrail();
  const dependencies = depsOf(db, audit);

  const created = await createClient({ actor: owner, body: VALID_BODY }, dependencies);
  const updatesBefore = db.updates.length;

  const removed = await deleteClient({ actor: owner, clientId: created.id }, dependencies);

  expectEqual(removed.id, created.id, "the removal answers the row it removed");
  expectEqual(removed.values.name, VALID_BODY.name, "with the values it carried");
  expectEqual(db.updates.length, updatesBefore + 1, "one update ran");
  const lastUpdate = at(db.updates, db.updates.length - 1, "the removal update");
  expect(
    lastUpdate.query.includes(`company_id=eq.${COMPANY_A}`) && lastUpdate.query.includes("deleted_at=is.null"),
    "the removal is scoped to one live row of the actor's company",
  );
  expectDeepEqual(Object.keys(lastUpdate.values), ["deleted_at"], "and sets the soft delete marker only");
  expect(
    typeof lastUpdate.values["deleted_at"] === "string" &&
      Number.isFinite(Date.parse(String(lastUpdate.values["deleted_at"]))),
    "to a real instant",
  );

  const lastAudit = at(audit.entries, audit.entries.length - 1, "the removal audit entry");
  expectEqual(lastAudit.action, CLIENT_DELETED_AUDIT_ACTION, "audited as client.deleted");
  expectEqual(lastAudit.entityType, "client", "against the client entity");
  expectEqual(lastAudit.entityId, created.id, "naming the row");
  expectEqual(lastAudit.companyId, COMPANY_A, "the company");
  expectEqual(lastAudit.actorUserId, OWNER_ID, "and the actor");
  expect(
    !JSON.stringify(lastAudit.payload).includes("amina@example.com"),
    "and never copying the client's email address into the log",
  );

  // the row is gone from every live read at once
  const readAfter = await rejectionOf(() => getClient({ actor: owner, clientId: created.id }, dependencies));
  expect(isAppError(readAfter) && readAfter.code === "RESOURCE_NOT_FOUND", "a removed client is a 404");

  const listAfter = await listClients({ actor: owner, query: parseClientListQuery({}) }, listDepsOf(db));
  expectEqual(listAfter.clients.length, 0, "and leaves the list");

  const searchAfter = await listClients(
    { actor: owner, query: parseClientListQuery({ search: "Amina" }) },
    listDepsOf(db),
  );
  expectEqual(searchAfter.clients.length, 0, "and the searches");

  // a second removal is refused rather than repeated
  const auditCountBefore = audit.entries.length;
  const second = await rejectionOf(() => deleteClient({ actor: owner, clientId: created.id }, dependencies));
  expect(isAppError(second) && second.code === "RESOURCE_NOT_FOUND", "removing it again is a 404, not a second marker");
  expectEqual(audit.entries.length, auditCountBefore, "and writes no second audit entry");

  // another merchant cannot remove this row, and learns nothing about it
  const other = await createClient({ actor: owner, body: { ...VALID_BODY, email: "other@example.com" } }, dependencies);
  const foreign = await rejectionOf(() => deleteClient({ actor: otherOwner, clientId: other.id }, dependencies));
  expect(isAppError(foreign) && foreign.code === "RESOURCE_NOT_FOUND", "a foreign removal is a 404, not the row");
  const stillThere = await getClient({ actor: owner, clientId: other.id }, dependencies);
  expectEqual(stillThere.id, other.id, "and the row is untouched");

  // only the owner may remove, exactly as only the owner may write
  const roleDenied = await rejectionOf(() => deleteClient({ actor: desk, clientId: other.id }, dependencies));
  expect(isAppError(roleDenied) && roleDenied.code === "PERMISSION_DENIED", "a non-owner role may not remove a client");

  const badId = await rejectionOf(() => deleteClient({ actor: owner, clientId: "not-a-uuid" }, dependencies));
  expect(isAppError(badId) && badId.code === "VALIDATION_FAILED", "a malformed id is a 422");

  // a deleted row releases its email, which is what the partial unique index of 0019 is for
  const reuse = await createClient({ actor: owner, body: { ...VALID_BODY } }, dependencies);
  expectEqual(reuse.values.email, VALID_BODY.email, "the address of a removed client can be used again");
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

  const deleteForm = await readRepositoryFile("app/(dashboard)/clients/[id]/delete-client-form.tsx");
  expect(deleteForm.includes('method: "DELETE"'), "the removal form sends DELETE");
  expect(deleteForm.includes("csrfHeaders("), "with the token in its headers");
  expect(!deleteForm.includes("body:"), "and no body, because a removal has none");
  expect(deleteForm.includes("router.push(\"/clients\")"), "navigating back to the list on success");
  expect(
    deleteForm.includes("setConfirming(true)") && deleteForm.includes("deleteCancel"),
    "behind a confirmation the merchant can leave",
  );

  for (const source of [screen, form, deleteForm]) {
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
    "app/(dashboard)/clients/[id]/delete-client-form.tsx",
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
  expect(
    editRoute.includes("export const POST") && editRoute.includes("export const GET"),
    "the edit route answers GET and POST",
  );
  expect(editRoute.includes("export const DELETE"), "and the removal of the same row");
  expect(!/export const (PUT|PATCH)/u.test(editRoute), "but no partial update");
  expect(editRoute.includes("deleteClient("), "whose removal calls the service");
  const deleteIndex = editRoute.indexOf("export const DELETE");
  const postIndex = editRoute.indexOf("export const POST");
  expect(
    editRoute.indexOf("requireCsrfToken(", deleteIndex) !== -1 &&
      editRoute.indexOf("requireCsrfToken(", deleteIndex) < postIndex,
    "the removal checks the token before the edit's handler begins",
  );
  expectEqual(
    editRoute.split("requireCsrfToken(").length - 1,
    2,
    "the edit route checks the token exactly once per mutation, and it answers two",
  );
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

/* ---- STEP 110: the CSV reader ---- */

/**
 * The reader on its own, before anything about clients.
 *
 * These are the cases a spreadsheet actually produces, and each one is a row that a split-on-comma
 * parser would shift. The header normalisation cases are here too, because a header matched too
 * strictly is every column in the file being ignored.
 */
function checkCsv(): void {
  /** The fields of every record but the header, for a file written inline. */
  const rowsOf = (text: string): readonly (readonly string[])[] => {
    const read = readCsv(text);

    if (!read.ok) {
      throw new Error(`the fixture file was refused: ${read.error.problem} on line ${String(read.error.line)}`);
    }

    return read.records.slice(1).map((record) => record.fields);
  };

  expectDeepEqual(rowsOf("name,email\nAmina,a@b.co"), [["Amina", "a@b.co"]], "a plain two column file reads");
  expectDeepEqual(
    rowsOf('name,notes\n"Amina, Jr",x'),
    [["Amina, Jr", "x"]],
    "a quoted comma stays inside its field",
  );
  expectDeepEqual(
    rowsOf('name\n"A ""quoted"" note"'),
    [['A "quoted" note']],
    "a doubled quote is one literal quote",
  );
  expectDeepEqual(rowsOf('name,notes\nAmina,"one\ntwo"'), [["Amina", "one\ntwo"]], "a quoted newline stays in its field");
  expectDeepEqual(rowsOf("name,email\r\nAmina,a@b.co\r\n"), [["Amina", "a@b.co"]], "CRLF line endings read");
  expectDeepEqual(rowsOf("name\nAmina"), [["Amina"]], "a file with no trailing newline reads");
  expectDeepEqual(rowsOf("name\nAmina\n"), [["Amina"]], "and one with a trailing newline reads the same");
  expectDeepEqual(rowsOf("\ufeffname\nAmina"), [["Amina"]], "a byte-order mark is removed");
  expectDeepEqual(rowsOf("name,email,phone\nAmina,,"), [["Amina", "", ""]], "empty cells read as empty fields");
  expectDeepEqual(rowsOf('name\n""'), [[""]], "a quoted empty field is one empty field");
  expectDeepEqual(rowsOf("name\nAmina\n\nBilal"), [["Amina"], ["Bilal"]], "blank lines are skipped");
  expectDeepEqual(rowsOf("name\n  Amina  "), [["  Amina  "]], "the reader does not trim a value");

  // a quoted field's own line count is what makes a refusal name the right line
  const multiline = readCsv('name,notes\nAmina,"a\nb\nc"\nBilal,x');

  const third = multiline.ok ? multiline.records[2] : undefined;

  expectEqual(third?.line, 5, "a record after a three-line quoted field starts on line five");

  // the four ways a file is not CSV
  for (const [text, problem] of [
    ['name\nSm"ith', "invalid_quote"],
    ['name\n"a"b', "invalid_quote"],
    ['name\n"unclosed', "invalid_quote"],
    ["x".repeat(MAXIMUM_CSV_CHARACTERS + 1), "too_large"],
  ] as const) {
    const read = readCsv(text);

    expect(!read.ok && read.error.problem === problem, `the file ${text.slice(0, 18)} is refused as ${problem}`);
  }

  const tooMany = readCsv(`name\n${Array.from({ length: MAXIMUM_CSV_ROWS }, () => "x").join("\n")}`);

  expect(!tooMany.ok && tooMany.error.problem === "too_many_rows", "more records than the ceiling is refused as too_many_rows");

  const emptyRead = readCsv("");

  expect(emptyRead.ok && emptyRead.records.length === 0, "an empty file reads as no records");

  // header matching: case, spacing and punctuation are dropped, nothing else is
  expectEqual(normaliseHeader("Company Name"), "companyname", "a header drops case and space");
  expectEqual(normaliseHeader("company_name"), "companyname", "and underscores");
  expectEqual(normaliseHeader(" COMPANY\u00a0NAME "), "companyname", "and a non-breaking space");
  expectEqual(normaliseHeader("E-Mail"), "email", "so E-Mail matches email");
}

/* ---- STEP 110: the import ---- */

/**
 * A file of two good rows and one bad address.
 *
 * Every row carries a street line because `0019`'s address rule demands one once a city is set - a
 * rule this file exercises rather than works around, and one the "form and import agree" check below
 * asserts from both sides.
 */
const IMPORT_FILE = [
  "Name,Email,Phone,Address,City",
  "Amina Rahman,amina@example.com,+880 1711 000001,12 Lake Road,Dhaka",
  "Broken Row,not-an-address,,12 Lake Road,Dhaka",
  "Bilal Khan,bilal@example.com,+880 1711 000002,4 Hill View,Chattogram",
].join("\n");

async function checkImportReport(): Promise<void> {
  const db = createDb();
  const audit = createInMemoryAuditTrail();
  const outcome = await importClients({ actor: owner, text: IMPORT_FILE }, depsOf(db, audit));

  expect(outcome.ok, "a file with one bad row still imports");

  if (!outcome.ok) {
    return;
  }

  const report = outcome.report;

  expectEqual(report.created, 2, "the two good rows were created");
  expectEqual(report.refused, 1, "the one bad row was refused");
  expectEqual(report.rows.length, 3, "and every row is reported");
  expectDeepEqual(
    report.columns,
    ["name", "email", "phone", "address_line1", "city"],
    "the header named its five fields",
  );

  const refused = report.rows.find((row) => row.status === "refused");

  expectEqual(refused?.line, 3, "the refused row is named by its line in the file");
  expectDeepEqual(
    refused?.problems,
    [{ field: "email", rule: "invalid_format" }],
    "with the field and the rule that refused it",
  );
  expectEqual(refused?.clientId, null, "a refused row names no client");

  const created = report.rows.filter((row) => row.status === "created");

  expectEqual(created.length, 2, "both created rows are reported as created");
  expect(created.every((row) => row.clientId !== null), "each names the client it created");
  expectEqual(created[0]?.name, "Amina Rahman", "and the name, so the merchant recognises it");

  // the interrupted row did not stop the ones after it
  expectEqual(db.rows.length, 2, "two rows were written");
  expectEqual(at(db.rows, 0, "first imported row")["name"], "Amina Rahman", "the first good row");
  expectEqual(at(db.rows, 1, "second imported row")["name"], "Bilal Khan", "and the good row after the bad one");

  // a refused row is reported by field and rule, never by value
  expect(
    !JSON.stringify(report.rows).includes("not-an-address"),
    "the report never repeats the value that failed",
  );
  expect(!JSON.stringify(report).includes("+880 1711 000001"), "nor any other value from the file");
  expect(!JSON.stringify(report).includes("12 Lake Road"), "nor an address it imported");

  // the run writes one summary entry, and each created client wrote its own
  const actions = audit.entries.map((entry) => entry.action);

  expectEqual(actions.filter((action) => action === CLIENT_CREATED_AUDIT_ACTION).length, 2, "each created client is audited");
  expectEqual(actions.filter((action) => action === "client.imported").length, 1, "and the run has one summary entry");

  const summary = at(
    audit.entries.filter((entry) => entry.action === "client.imported"),
    0,
    "import summary",
  );

  expectEqual(summary.companyId, COMPANY_A, "the summary names the company");
  expectEqual(summary.actorUserId, OWNER_ID, "and the actor");
  const payload = summary.payload as Readonly<Record<string, unknown>>;

  expectDeepEqual(
    payload["columns"],
    ["name", "email", "phone", "address_line1", "city"],
    "and the fields the file supplied",
  );
  expectEqual(payload["created"], 2, "with how many were taken");
  expectEqual(payload["refused"], 1, "and how many were not");
}

async function checkImportHeaders(): Promise<void> {
  const db = createDb();

  /** The outcome of importing one file, against an empty book. */
  const importOf = async (text: string) => importClients({ actor: owner, text }, depsOf(createDb()));

  // header spellings a spreadsheet actually produces
  for (const [header, expected] of [
    ["Name,Email", ["name", "email"]],
    ["name,email_address", ["name", "email"]],
    ["CLIENT NAME,E-MAIL,MOBILE", ["name", "email", "phone"]],
    [
      "Name,Company,Address,City,Zip,Country,VAT,Notes",
      ["name", "company_name", "address_line1", "city", "postal_code", "country", "tax_id", "notes"],
    ],
    ["Name,State", ["name", "region"]],
    ["Name,ZIP Code", ["name", "postal_code"]],
  ] as const) {
    const outcome = await importOf(`${header}\nAmina,a@b.co`);

    expect(outcome.ok, `the header ${header} is understood`);
    expectDeepEqual(
      outcome.ok ? outcome.report.columns : [],
      [...expected],
      `the header ${header} maps to ${expected.join(",")}`,
    );
  }

  // an unknown column is ignored rather than refused, so a re-import of an export works
  const withExtras = await importOf("Name,Email,id,Created At\nAmina,a@b.co,abc,2026-01-01");

  expect(
    withExtras.ok && withExtras.report.ignoredColumns.length === 2,
    "a column the import does not use is ignored and named",
  );
  expect(withExtras.ok && withExtras.report.created === 1, "and the row still imports");

  // a file with no name column is refused once, not once per row
  const noName = await importOf("Email,Phone\na@b.co,123456");

  expect(!noName.ok && noName.problem === "header_missing", "a file with no name column is refused as header_missing");
  expect(!noName.ok && noName.line === 1, "naming the header line");

  // two columns for one field is refused, because there is no honest winner
  const twice = await importOf("Name,Email,E-Mail\nAmina,a@b.co,c@d.co");

  expect(!twice.ok && twice.problem === "header_duplicate", "two columns for one field is refused as header_duplicate");

  // a row wider than the header is a shifted row
  const wide = await importOf("Name,Email\nAmina,a@b.co,extra");

  expect(!wide.ok && wide.problem === "row_too_wide", "a row wider than the header is refused as row_too_wide");
  expect(!wide.ok && wide.line === 2, "naming the row");
  expectEqual(db.rows.length, 0, "and nothing was written");

  // a file with only a header imports nothing and refuses nothing
  const headerOnly = await importOf("Name,Email");

  expect(headerOnly.ok && headerOnly.report.created === 0 && headerOnly.report.refused === 0, "a header alone is an empty import");

  // an empty file is a refusal about the file
  const empty = await importOf("");

  expect(!empty.ok && empty.problem === "empty", "an empty file is refused as empty");

  // a broken quote is reported at the line it broke on
  const broken = await importOf('Name,Email\nAmina,a@b.co\nBilal,"unclosed');

  expect(!broken.ok && broken.problem === "invalid_quote", "a broken quote is refused as invalid_quote");
  expect(!broken.ok && broken.line === 3, "naming the line it broke on");
}

async function checkImportValidation(): Promise<void> {
  const db = createDb();

  /**
   * The same body posted through the form and through the import must be judged the same way. This is
   * the assertion that keeps the importer from becoming a second, looser definition of a valid client.
   */
  const bodies: readonly (readonly [string, Record<string, string>])[] = [
    ["a missing name", { name: "" }],
    ["a name past its ceiling", { name: "x".repeat(121) }],
    ["a bad address", { name: "Amina", email: "nope" }],
    ["a bad phone", { name: "Amina", phone: "abc" }],
    ["a city with no street line", { name: "Amina", city: "Dhaka" }],
    ["a country that is not two letters", { name: "Amina", country: "Bangladesh" }],
    ["a postal code of one character", { name: "Amina", postal_code: "1" }],
    ["notes past their ceiling", { name: "Amina", notes: "x".repeat(2_001) }],
  ];

  for (const [description, body] of bodies) {
    const direct = await rejectionOf(() => createClient({ actor: owner, body }, depsOf(createDb())));
    const directDetails = isAppError(direct) && direct.code === "VALIDATION_FAILED" ? direct.details : [];

    expect(directDetails.length > 0, `the form refuses ${description}`);

    // the same values through a one-row file
    const header = ["name", ...Object.keys(body).filter((key) => key !== "name")].join(",");
    const values = [body["name"] ?? "", ...Object.keys(body).filter((key) => key !== "name").map((key) => body[key] ?? "")];
    const outcome = await importClients(
      { actor: owner, text: `${header}\n${values.map((value) => `"${value.replaceAll('"', '""')}"`).join(",")}` },
      depsOf(db),
    );

    expect(outcome.ok, `the import reads the one row file for ${description}`);
    expectEqual(
      outcome.ok ? outcome.report.refused : -1,
      1,
      `the import refuses ${description} exactly as the form does`,
    );

    const problems = outcome.ok ? (outcome.report.rows[0]?.problems ?? []) : [];

    expectDeepEqual(
      problems.map((problem) => problem.field).sort(),
      directDetails.map((detail) => detail.field).sort(),
      `and names the same fields for ${description}`,
    );
    expectDeepEqual(
      problems.map((problem) => problem.rule).sort(),
      directDetails.map((detail) => detail.rule).sort(),
      `and the same rules for ${description}`,
    );
  }

  // a duplicate address inside one file is refused on the second row, not the whole file
  const twice = await importClients(
    {
      actor: owner,
      text: "Name,Email\nAmina,amina@example.com\nAmina Again,AMINA@example.com",
    },
    depsOf(db),
  );

  expect(twice.ok && twice.report.created === 1, "the first of two identical addresses is created");
  expect(twice.ok && twice.report.refused === 1, "and the second is refused");
  expectDeepEqual(
    twice.ok ? (twice.report.rows[1]?.problems ?? []) : [],
    [{ field: "email", rule: "already_used" }],
    "naming the email as already used, case insensitively",
  );
  expect(twice.ok && twice.report.rows[1]?.line === 3, "on the line that caused it");

  // an existing client of the same merchant is a row refusal, so the rest of the file still lands
  const existing = await createClient(
    { actor: owner, body: { name: "Already Here", email: "taken@example.com" } },
    depsOf(db),
  );
  const mixed = await importClients(
    { actor: owner, text: "Name,Email\nNew One,new@example.com\nTaken,taken@example.com" },
    depsOf(db),
  );

  expect(existing.id.length > 0, "the fixture client exists");
  expect(mixed.ok && mixed.report.created === 1, "a file naming an existing client still imports the rest");
  expectDeepEqual(
    mixed.ok ? (mixed.report.rows[1]?.problems ?? []) : [],
    [{ field: "email", rule: "already_used" }],
    "and reports the clash on that row",
  );
}

async function checkImportTenancy(): Promise<void> {
  const db = createDb();
  const file = "Name,Email\nAmina,amina@example.com";

  // only the owner may import, exactly as only the owner may create
  for (const roles of [["compliance_kyc"], ["finance_ops"], ["support"], ["ceo"], ["super_admin"], ["blogger"]] as const) {
    const refused = await rejectionOf(() =>
      importClients(
        { actor: actorOf([...roles], COMPANY_A, { userId: OFFICE_ID }), text: file },
        depsOf(createDb()),
      ),
    );

    expect(isAppError(refused) && refused.code === "PERMISSION_DENIED", `the role ${roles[0]} may not import clients`);
  }

  const platformAccount = await rejectionOf(() =>
    importClients({ actor: desk, text: file }, depsOf(createDb())),
  );

  expect(isAppError(platformAccount), "an account with no company cannot import into one");

  // everything created belongs to the actor's company and nothing else
  const imported = await importClients({ actor: owner, text: file }, depsOf(db));

  expect(imported.ok && imported.report.created === 1, "the owner imports one client");
  expectEqual(db.rows.length, 1, "one row was written");
  expectEqual(at(db.rows, 0, "imported row")["company_id"], COMPANY_A, "scoped to the actor's company");

  // another merchant importing the same file gets their own client, because the index is per company
  const other = await importClients({ actor: otherOwner, text: file }, depsOf(db));

  expect(other.ok && other.report.created === 1, "another merchant imports the same address into their own book");
  expectEqual(db.rows.length, 2, "which is a second row, not an overwrite");

  // and the one import wrote one summary entry on its own company's chain
  expectEqual(
    at(db.rows, 1, "second row")["company_id"],
    COMPANY_B,
    "the second row belongs to the second merchant",
  );
}

async function checkImportSources(): Promise<void> {
  for (const path of [
    "services/clients/csv.ts",
    "services/clients/client-import.ts",
    "app/api/clients/import/route.ts",
    "app/(dashboard)/clients/import/client-import-form.tsx",
    "app/(dashboard)/clients/import/page.tsx",
  ]) {
    const source = await readRepositoryFile(path);

    expect(source.length > 0, `${path} exists`);
    expect(source.split("\n", 1)[0]?.trim() === `// path: ${path}`, `${path} starts with its path comment`);
    expect(!/[^\u0009\u000a\u000d\u0020-\u007e]/u.test(source.replaceAll("\ufeff", "")), `${path} is ASCII only`);
  }

  const importModule = await readRepositoryFile("services/clients/client-import.ts");

  // the importer validates by calling the same service, never by reading a row of its own
  expect(importModule.includes("createClient("), "every row goes through createClient");
  expectEqual(/insertReturning\(/u.test(importModule), false, "the import opens no insert of its own");
  expectEqual(/CLIENTS_TABLE/u.test(importModule), false, "and names no table");
  expect(importModule.includes("requireAnyRole\(") === false, "so it states no role of its own either");

  // a refused row does not stop the run, and an outage does
  expect(importModule.includes("catch (error)"), "a row failure is caught per row");
  expect(importModule.includes("throw error"), "and a failure that is not the row's stops the run");

  // the reader is written here, not taken from a package
  const packageJson = JSON.parse(await readRepositoryFile("package.json")) as {
    readonly dependencies?: Readonly<Record<string, string>>;
  };
  const dependencies = Object.keys(packageJson.dependencies ?? {});

  expect(
    !dependencies.some((name) => /csv|papaparse|parse-csv/u.test(name)),
    "no CSV package is a dependency: the reader is in services/clients/csv.ts",
  );

  const route = await readRepositoryFile("app/api/clients/import/route.ts");

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
  expect(route.includes('"cache-control": "no-store"'), "and is never cached");

  // the list is the way in: a merchant with a spreadsheet finds the import where the clients are
  const listPage = await readRepositoryFile("app/(dashboard)/clients/page.tsx");

  expect(listPage.includes('href="/clients/import"'), "the client list links to the import");
  expect(listPage.includes("clients.importLink"), "with its own label in the catalog");

  const csrf = await readRepositoryFile("lib/security/csrf.ts");

  expect(csrf.includes('"/api/clients/import"'), "the import route is on the protected list");

  // the screen posts a file through the one form, with the token
  const form = await readRepositoryFile("app/(dashboard)/clients/import/client-import-form.tsx");

  expect(form.includes('method: "POST"'), "the form posts");
  expect(form.includes("csrfHeaders("), "carrying the CSRF token");
  expect(form.includes("type=\"file\"") || form.includes('type="file"'), "it takes a file");
  expect(form.includes("accept="), "of the types it accepts");
  expect(form.includes("report.rows") || form.includes("rows.map"), "and prints the report row by row");
}

async function main(): Promise<void> {
  await checkCreate();
  await checkValidation();
  await checkReadAndUpdate();
  await checkDelete();
  await checkListPaging();
  await checkListSearch();
  await checkListTenancy();
  await checkListSources();
  checkCsv();
  await checkImportReport();
  await checkImportHeaders();
  await checkImportValidation();
  await checkImportTenancy();
  await checkImportSources();
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
