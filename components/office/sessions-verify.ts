// path: components/office/sessions-verify.ts
import { readdir, readFile } from "node:fs/promises";
import process from "node:process";
import type { z } from "zod";
import {
  SESSION_SEARCH_MAXIMUM_LENGTH,
  readAccountSessions,
  subjectKindOf,
  type AccountSessionsSnapshot,
  type SessionConsoleDependencies,
} from "../../app/(admin)/account-sessions/session-console.ts";
import { createInMemoryAuditTrail, type InMemoryAuditTrail } from "../../lib/auth/audit.ts";
import type { RestClient } from "../../lib/auth/rest.ts";
import {
  SESSION_LIST_LIMIT,
  SESSION_MANAGEMENT_OFFICE_ROLES,
} from "../../lib/auth/session-list.ts";
import type { SessionTokenStore } from "../../lib/auth/session-rotation.ts";
import type { PlatformRole, RequestActor } from "../../lib/auth/types.ts";
import { en } from "../../lib/i18n/strings/en.ts";

/**
 * The account session console gate: run with `node components/office/sessions-verify.ts`.
 *
 * STEP 054 built the rule - `listAccountSessions`, `revokeAccountSession`, the route with the CSRF
 * token, the device proof and the fresh reauthentication. What this STEP adds is the step in front of
 * it, and this gate proves four things about that step:
 *
 *   1. **A search resolves to one account, or to none.** An identifier or an exact address goes to
 *      `users` with `limit=1`, `deleted_at=is.null` and the matching index behind it; anything else is
 *      refused at the form; a shape the box cannot mean never reaches the database.
 *   2. **The refusal comes before the query.** A role outside `SESSION_MANAGEMENT_OFFICE_ROLES` is
 *      refused with no query and no audit entry, so the "no account" sentence cannot be used to ask
 *      whether an address exists.
 *   3. **The read is STEP 054's.** The sessions, the live filter, the fifty-row ceiling, the audit
 *      entry `session.list_read_by_office` and the `current` flag all come from `listAccountSessions`,
 *      unchanged, and the counts on this screen are arithmetic over its answer.
 *   4. **The write is STEP 054's route.** The console posts only to `/api/office/sessions/revoke`, one
 *      request per session, and this STEP adds no endpoint and no migration - the indexes it reads,
 *      `users_email_key` and `sessions_user_idx`, were created by `0003` and `0010`.
 *
 * The module runs over an in-memory PostgREST with the four methods `RestClient` exposes, so what
 * passes here is the code the page runs. The page, the client console, the navigation entry and the
 * migration set are read as source, because a `.tsx` file cannot be imported by plain Node.
 *
 * ## What it cannot prove
 *
 * That PostgREST is reachable, that a person can press the button at two widths, and that the audit
 * trail of a real project receives the entries - those are deployment and browser facts, and the
 * handoff lists the checks a person runs against a real project.
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
    failures.push(
      `${description} (expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)})`,
    );
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

/** The instant every scenario runs at: the clock the page would read. */
const NOW = Date.parse("2026-11-02T10:30:00.000Z");

const OFFICER_ID = "018f2b8a-1111-4c2d-9c3e-000000000001";
const CEO_ID = "018f2b8a-1111-4c2d-9c3e-000000000002";
const DESK_ID = "018f2b8a-1111-4c2d-9c3e-000000000003";
const SUPPORT_ID = "018f2b8a-1111-4c2d-9c3e-000000000004";
const FINANCE_ID = "018f2b8a-1111-4c2d-9c3e-000000000005";
const BLOGGER_ID = "018f2b8a-1111-4c2d-9c3e-000000000006";

const COMPANY_ID = "018f2b8a-4444-4c2d-9c3e-000000000001";

const ADA_ID = "018f2b8a-5555-4c2d-9c3e-000000000001";
const BOB_ID = "018f2b8a-5555-4c2d-9c3e-000000000002";
const GONE_ID = "018f2b8a-5555-4c2d-9c3e-000000000003";

const ADA_SESSION_TRUSTED = "018f2b8a-7777-4c2d-9c3e-000000000001";
const ADA_SESSION_PLAIN = "018f2b8a-7777-4c2d-9c3e-000000000002";
const ADA_SESSION_DROPPED = "018f2b8a-7777-4c2d-9c3e-000000000003";
const ADA_SESSION_NO_DEVICE = "018f2b8a-7777-4c2d-9c3e-000000000004";
const ADA_SESSION_ENDED = "018f2b8a-7777-4c2d-9c3e-000000000005";

const DEVICE_TRUSTED = "018f2b8a-8888-4c2d-9c3e-000000000001";
const DEVICE_PLAIN = "018f2b8a-8888-4c2d-9c3e-000000000002";
const DEVICE_DROPPED = "018f2b8a-8888-4c2d-9c3e-000000000003";

function actorOf(roles: readonly PlatformRole[], overrides: Partial<RequestActor> = {}): RequestActor {
  return {
    userId: OFFICER_ID,
    companyId: null,
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

const supervisor = actorOf(["super_admin"]);
const ceo = actorOf(["ceo"], { userId: CEO_ID });
const desk = actorOf(["compliance_kyc"], { userId: DESK_ID });
const support = actorOf(["support"], { userId: SUPPORT_ID });

/** The roles and accounts the screen must refuse, before it reads anything. */
const refusedActors: readonly (readonly [string, RequestActor])[] = [
  ["finance_ops", actorOf(["finance_ops"], { userId: FINANCE_ID })],
  ["blogger", actorOf(["blogger"], { userId: BLOGGER_ID })],
  ["owner", actorOf(["owner"], { userId: ADA_ID, companyId: COMPANY_ID })],
  ["nobody", actorOf([])],
];

type Row = Record<string, unknown>;

/** The accounts a seeded office would hold: one with a company, one without, one deleted. */
function accountRows(): Row[] {
  return [
    {
      id: ADA_ID,
      email: "ada@example.test",
      full_name: "Ada Merchant",
      company_id: COMPANY_ID,
      deleted_at: null,
    },
    {
      id: BOB_ID,
      email: "bob@example.test",
      full_name: "Bob Merchant",
      company_id: null,
      deleted_at: null,
    },
    {
      id: GONE_ID,
      email: "gone@example.test",
      full_name: "Gone Merchant",
      company_id: null,
      deleted_at: "2026-10-01T00:00:00.000Z",
    },
  ];
}

/** Four live sessions on Ada's account, newest first, and one that is already ended. */
function sessionRows(): Row[] {
  return [
    {
      id: ADA_SESSION_TRUSTED,
      user_id: ADA_ID,
      device_proof_key_id: DEVICE_TRUSTED,
      issued_at: "2026-11-02T10:00:00.000Z",
      last_seen_at: "2026-11-02T10:25:00.000Z",
      expires_at: "2026-11-02T18:00:00.000Z",
      revoked_at: null,
      deleted_at: null,
    },
    {
      id: ADA_SESSION_PLAIN,
      user_id: ADA_ID,
      device_proof_key_id: DEVICE_PLAIN,
      issued_at: "2026-11-02T09:00:00.000Z",
      last_seen_at: "2026-11-02T10:20:00.000Z",
      expires_at: "2026-11-02T17:00:00.000Z",
      revoked_at: null,
      deleted_at: null,
    },
    {
      id: ADA_SESSION_DROPPED,
      user_id: ADA_ID,
      device_proof_key_id: DEVICE_DROPPED,
      issued_at: "2026-11-02T08:00:00.000Z",
      last_seen_at: "2026-11-02T08:10:00.000Z",
      expires_at: "2026-11-02T16:00:00.000Z",
      revoked_at: null,
      deleted_at: null,
    },
    {
      id: ADA_SESSION_NO_DEVICE,
      user_id: ADA_ID,
      device_proof_key_id: null,
      issued_at: "2026-11-02T07:00:00.000Z",
      last_seen_at: "2026-11-02T07:30:00.000Z",
      expires_at: "2026-11-02T15:00:00.000Z",
      revoked_at: null,
      deleted_at: null,
    },
    {
      id: ADA_SESSION_ENDED,
      user_id: ADA_ID,
      device_proof_key_id: DEVICE_PLAIN,
      issued_at: "2026-11-01T10:00:00.000Z",
      last_seen_at: "2026-11-01T11:00:00.000Z",
      expires_at: "2026-11-01T18:00:00.000Z",
      revoked_at: "2026-11-01T12:00:00.000Z",
      deleted_at: null,
    },
  ];
}

function deviceRows(): Row[] {
  return [
    {
      id: DEVICE_TRUSTED,
      label: "Ada's laptop",
      trusted_at: "2026-10-20T09:00:00.000Z",
      revoked_at: null,
      deleted_at: null,
    },
    {
      id: DEVICE_PLAIN,
      label: null,
      trusted_at: null,
      revoked_at: null,
      deleted_at: null,
    },
    {
      id: DEVICE_DROPPED,
      label: "Ada's old phone",
      trusted_at: "2026-09-01T09:00:00.000Z",
      revoked_at: "2026-10-30T09:00:00.000Z",
      deleted_at: null,
    },
  ];
}

interface Filter {
  readonly column: string;
  readonly operator: "eq" | "isNull" | "isNotNull" | "in";
  readonly values: readonly string[];
}

interface ParsedQuery {
  readonly filters: readonly Filter[];
  readonly order: readonly (readonly [string, "asc" | "desc"])[];
  readonly limit: number;
  readonly offset: number;
}

/** The operators these queries use: `eq`, `is.null`, `not.is.null` and `in.(...)`. */
function parseFilters(query: string): ParsedQuery {
  const filters: Filter[] = [];
  const order: (readonly [string, "asc" | "desc"])[] = [];
  let limit = 1_000;
  let offset = 0;

  for (const part of query.split("&")) {
    if (part.length === 0 || part.startsWith("select=")) {
      continue;
    }

    if (part.startsWith("order=")) {
      for (const entry of part.slice("order=".length).split(",")) {
        const [column, direction] = entry.split(".");

        if (column !== undefined) {
          order.push([column, direction === "asc" ? "asc" : "desc"]);
        }
      }

      continue;
    }

    if (part.startsWith("limit=")) {
      limit = Number.parseInt(part.slice("limit=".length), 10);
      continue;
    }

    if (part.startsWith("offset=")) {
      offset = Number.parseInt(part.slice("offset=".length), 10);
      continue;
    }

    const separator = part.indexOf("=");

    if (separator === -1) {
      throw new Error(`the gate's store cannot read this part: ${part}`);
    }

    const column = decodeURIComponent(part.slice(0, separator));
    const expression = part.slice(separator + 1);

    if (expression === "is.null") {
      filters.push({ column, operator: "isNull", values: [] });
      continue;
    }

    if (expression === "not.is.null") {
      filters.push({ column, operator: "isNotNull", values: [] });
      continue;
    }

    if (expression.startsWith("eq.")) {
      filters.push({ column, operator: "eq", values: [decodeURIComponent(expression.slice(3))] });
      continue;
    }

    if (expression.startsWith("in.(") && expression.endsWith(")")) {
      filters.push({
        column,
        operator: "in",
        values: expression
          .slice(4, -1)
          .split(",")
          .map((value) => decodeURIComponent(value.trim())),
      });
      continue;
    }

    throw new Error(`the gate's store does not speak this operator: ${part}`);
  }

  return { filters, order, limit, offset };
}

function matches(row: Row, filter: Filter): boolean {
  const value = row[filter.column];

  if (filter.operator === "isNull") {
    return value === null || value === undefined;
  }

  if (filter.operator === "isNotNull") {
    return value !== null && value !== undefined;
  }

  if (filter.operator === "eq") {
    return String(value ?? "") === filter.values[0];
  }

  return filter.values.includes(String(value ?? ""));
}

interface FakeDatabase {
  readonly tables: Record<string, Row[]>;
  readonly queries: string[];
  readonly writes: string[];
}

function createDatabase(): FakeDatabase {
  return {
    tables: {
      users: accountRows(),
      sessions: sessionRows(),
      device_proof_keys: deviceRows(),
    },
    queries: [],
    writes: [],
  };
}

function createStore(database: FakeDatabase): RestClient {
  return {
    select<TRow>(table: string, query: string, schema: z.ZodType<TRow>): Promise<readonly TRow[]> {
      database.queries.push(`${table}?${query}`);

      const { filters, order, limit, offset } = parseFilters(query);
      const rows = database.tables[table] ?? [];
      const matched = rows.filter((row) => filters.every((filter) => matches(row, filter)));

      for (const [column, direction] of [...order].reverse()) {
        matched.sort((left, right) => {
          const leftValue = String(left[column] ?? "");
          const rightValue = String(right[column] ?? "");
          const comparison = leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;

          return direction === "asc" ? comparison : -comparison;
        });
      }

      return Promise.resolve(matched.slice(offset, offset + limit).map((row) => schema.parse(row)));
    },
    insert(table: string): Promise<void> {
      database.writes.push(`insert ${table}`);

      return Promise.reject(new Error("the session console never inserts"));
    },
    insertReturning(table: string): Promise<never> {
      database.writes.push(`insertReturning ${table}`);

      return Promise.reject(new Error("the session console never inserts"));
    },
    update(table: string): Promise<void> {
      database.writes.push(`update ${table}`);

      return Promise.reject(new Error("the revoke act belongs to STEP 054, not to this screen"));
    },
    rpc(name: string): Promise<unknown> {
      database.writes.push(`rpc ${name}`);

      return Promise.reject(new Error("the session console calls no function"));
    },
  };
}

/** The rotating token store is STEP 051's; reading a list never touches it. */
const unusedTokenStore: SessionTokenStore = {
  findByHash: (): Promise<never> => Promise.reject(new Error("the console reads no token")),
  findLiveInFamily: (): Promise<never> => Promise.reject(new Error("the console reads no family")),
  insert: (): Promise<never> => Promise.reject(new Error("the console inserts no row")),
  update: (): Promise<never> => Promise.reject(new Error("the console updates no row")),
  revokeFamily: (): Promise<never> => Promise.reject(new Error("the console revokes no family")),
  revokeDevice: (): Promise<never> => Promise.reject(new Error("the console revokes no device")),
};

interface Harness {
  readonly database: FakeDatabase;
  readonly audit: InMemoryAuditTrail;
  readonly dependencies: SessionConsoleDependencies;
}

function harnessOf(): Harness {
  const database = createDatabase();
  const audit = createInMemoryAuditTrail();

  return {
    database,
    audit,
    dependencies: {
      rest: createStore(database),
      audit,
      sessions: unusedTokenStore,
      now: (): number => NOW,
    },
  };
}

async function failureOf(call: () => Promise<unknown>): Promise<string> {
  try {
    await call();

    return "no-throw";
  } catch (error) {
    const code = (error as { readonly code?: unknown }).code;

    return typeof code === "string" ? code : `defect: ${String(error)}`;
  }
}

async function detailOf(call: () => Promise<unknown>): Promise<unknown> {
  try {
    await call();

    return "no-throw";
  } catch (error) {
    const details = (error as { readonly details?: unknown }).details;

    return details ?? "no-details";
  }
}

/** ---- The constants and the pure functions. */
function checkConstants(): void {
  expectEqual(
    SESSION_MANAGEMENT_OFFICE_ROLES.join(","),
    "super_admin,ceo,compliance_kyc,support",
    "the four session roles are STEP 054's, not a copy",
  );
  expectEqual(SESSION_LIST_LIMIT, 50, "the list ceiling is STEP 054's fifty");
  expectEqual(SESSION_SEARCH_MAXIMUM_LENGTH, 254, "a search is at most one address long");
  expectEqual(SESSION_MANAGEMENT_OFFICE_ROLES.includes("finance_ops"), false, "finance operations is not a session role");
  expectEqual(SESSION_MANAGEMENT_OFFICE_ROLES.includes("owner"), false, "and neither is the merchant owner");
}

function checkSubjectKind(): void {
  expectEqual(subjectKindOf(ADA_ID), "uuid", "an identifier is recognised");
  expectEqual(subjectKindOf(`  ${ADA_ID.toUpperCase()}  `), "uuid", "an upper case identifier, padded, is still one");
  expectEqual(subjectKindOf("ada@example.test"), "email", "an address is recognised");
  expectEqual(subjectKindOf("  Ada@Example.Test  "), "email", "an address is recognised whatever its case");
  expectEqual(subjectKindOf("ada+support@sub.example.co"), "email", "a plus address on a subdomain is an address");
  expectEqual(subjectKindOf(""), "empty", "an empty search is empty");
  expectEqual(subjectKindOf("   "), "empty", "and so is one of spaces");
  expectEqual(subjectKindOf("ada"), "invalid", "a bare word is refused");
  expectEqual(subjectKindOf("ada@"), "invalid", "an address without a domain is refused");
  expectEqual(subjectKindOf("ada@example"), "invalid", "a domain without a dot is refused");
  expectEqual(subjectKindOf("ada@example.c"), "invalid", "a one letter top level domain is refused");
  expectEqual(subjectKindOf("ada @example.test"), "invalid", "an address with a space is refused");
  expectEqual(subjectKindOf("018f2b8a11114c2d9c3e000000000001"), "invalid", "an identifier without dashes is refused");
  expectEqual(subjectKindOf("{018f2b8a-1111-4c2d-9c3e-000000000001}"), "invalid", "a braced identifier is refused");
  expectEqual(
    subjectKindOf(`${"a".repeat(241)}@example.test`),
    "email",
    "an address of exactly 254 characters is the longest that is accepted",
  );
  expectEqual(
    subjectKindOf(`${"a".repeat(242)}@example.test`),
    "invalid",
    "one character longer is refused before any query",
  );
}

/** ---- The refusals: no query, no audit entry, so an address cannot be probed. */
async function checkRefusals(): Promise<void> {
  for (const [label, actor] of refusedActors) {
    const harness = harnessOf();

    expectEqual(
      await failureOf(() => readAccountSessions({ actor, query: "ada@example.test" }, harness.dependencies)),
      "PERMISSION_DENIED",
      `${label} may not read an account's sessions`,
    );
    expectEqual(harness.database.queries.length, 0, `and ${label} is refused before the first query`);
    expectEqual(harness.audit.entries.length, 0, `and ${label} leaves no audit entry`);
  }

  for (const [label, actor] of [
    ["the super administrator", supervisor],
    ["the chief executive", ceo],
    ["the compliance desk", desk],
    ["support", support],
  ] as const) {
    const harness = harnessOf();

    expect(
      (await readAccountSessions({ actor, query: ADA_ID }, harness.dependencies)) !== null,
      `${label} may read an account's sessions`,
    );
  }
}

/** ---- The search: one account or none, on an index, with the shape refused first. */
async function checkResolution(): Promise<void> {
  const byId = harnessOf();
  const snapshot = await readAccountSessions({ actor: support, query: ADA_ID }, byId.dependencies);

  expect(snapshot !== null, "an identifier resolves");
  expectEqual(snapshot?.subject.userId, ADA_ID, "to the account it names");
  expectEqual(snapshot?.subject.email, "ada@example.test", "with the address on the account");
  expectEqual(snapshot?.subject.fullName, "Ada Merchant", "and its name");
  expectEqual(snapshot?.subject.companyId, COMPANY_ID, "and the company it belongs to");
  expectEqual(byId.database.queries[0]?.split("?")[0], "users", "the first read is the account");
  const idQuery = decodeURIComponent(byId.database.queries[0] ?? "");
  expect(idQuery.includes(`id=eq.${ADA_ID}`), "looked up by its identifier");
  expect(idQuery.includes("deleted_at=is.null"), "ignoring deleted accounts");
  expect(idQuery.includes("limit=1"), "and taking at most one row");
  expect(idQuery.includes("users_email_key") === false, "the identifier reads the primary key, not the address index");

  const byEmail = harnessOf();
  const found = await readAccountSessions({ actor: supervisor, query: "  ADA@Example.Test " }, byEmail.dependencies);

  expect(found !== null, "an address resolves");
  expectEqual(found?.subject.userId, ADA_ID, "to the account that carries it");
  const emailQuery = decodeURIComponent(byEmail.database.queries[0] ?? "");
  expect(emailQuery.includes("email=eq.ada@example.test"), "the address is lower cased before the lookup");

  const noCompany = await readAccountSessions({ actor: ceo, query: "bob@example.test" }, harnessOf().dependencies);

  expectEqual(noCompany?.subject.companyId, null, "an account without a company resolves without one");

  const missing = harnessOf();

  expectEqual(
    await readAccountSessions({ actor: supervisor, query: "nobody@example.test" }, missing.dependencies),
    null,
    "an address nobody carries resolves to nothing",
  );
  expectEqual(
    missing.database.queries.filter((query) => query.startsWith("sessions?")).length,
    0,
    "and no session is read for an account that does not exist",
  );

  expectEqual(
    await readAccountSessions({ actor: supervisor, query: GONE_ID }, harnessOf().dependencies),
    null,
    "a deleted account resolves to nothing",
  );

  const empty = harnessOf();

  expectEqual(
    await failureOf(() => readAccountSessions({ actor: supervisor, query: "   " }, empty.dependencies)),
    "VALIDATION_FAILED",
    "an empty search is a validation failure",
  );
  expectDeepEqual(
    await detailOf(() => readAccountSessions({ actor: supervisor, query: "" }, harnessOf().dependencies)),
    [{ field: "account", rule: "required" }],
    "and says which field and which rule",
  );
  expectEqual(empty.database.queries.length, 0, "an empty search reads nothing");

  const invalid = harnessOf();

  expectEqual(
    await failureOf(() => readAccountSessions({ actor: supervisor, query: "ada" }, invalid.dependencies)),
    "VALIDATION_FAILED",
    "a search of the wrong shape is a validation failure",
  );
  expectDeepEqual(
    await detailOf(() => readAccountSessions({ actor: supervisor, query: "ada" }, harnessOf().dependencies)),
    [{ field: "account", rule: "invalid_format" }],
    "and says the shape is wrong",
  );
  expectEqual(invalid.database.queries.length, 0, "and a search of the wrong shape reads nothing");
}

/** ---- The read: STEP 054's rows, STEP 054's audit entry, arithmetic over its answer. */
async function checkSnapshot(): Promise<void> {
  const harness = harnessOf();
  const snapshot: AccountSessionsSnapshot | null = await readAccountSessions(
    { actor: supervisor, query: ADA_ID },
    harness.dependencies,
  );

  if (snapshot === null) {
    expect(false, "the seeded account resolves");

    return;
  }

  expectEqual(snapshot.readAtEpochMs, NOW, "the read is stamped with the clock the page was given");
  expectEqual(snapshot.sessions.length, 4, "the four live sessions are listed");
  expectEqual(
    snapshot.sessions.map((session) => session.id).join(","),
    [ADA_SESSION_TRUSTED, ADA_SESSION_PLAIN, ADA_SESSION_DROPPED, ADA_SESSION_NO_DEVICE].join(","),
    "newest first, the way STEP 054 orders them",
  );
  expectEqual(
    snapshot.sessions.some((session) => session.id === ADA_SESSION_ENDED),
    false,
    "and the session that already ended is not",
  );
  expectEqual(snapshot.sessions[0]?.deviceLabel, "Ada's laptop", "a labelled device carries its label");
  expectEqual(snapshot.sessions[1]?.deviceLabel, null, "an unlabelled device carries none");
  expectEqual(snapshot.sessions[0]?.deviceTrusted, true, "a confirmed device is marked confirmed");
  expectEqual(snapshot.sessions[1]?.deviceTrusted, false, "an unconfirmed one is not");
  expectEqual(snapshot.sessions[2]?.deviceRevoked, true, "a dropped device is marked dropped");
  expectEqual(snapshot.sessions[3]?.deviceId, null, "a session bound to no device says so");
  expectEqual(
    snapshot.sessions.every((session) => !session.current),
    true,
    "no row is the officer's own session",
  );
  expectDeepEqual(
    snapshot.counts,
    { live: 4, trustedDevices: 1, unconfirmedDevices: 2, droppedDevices: 1 },
    "the counts divide the rows: one confirmed device, two unconfirmed, one dropped",
  );
  expectEqual(
    harness.audit.entries.length,
    1,
    "the read appends exactly one audit entry, STEP 054's",
  );
  expectEqual(
    harness.audit.entries[0]?.action,
    "session.list_read_by_office",
    "and it is the office read of another account's sessions",
  );
  expectEqual(harness.audit.entries[0]?.actorUserId, OFFICER_ID, "naming the officer who read it");
  expectEqual(harness.audit.entries[0]?.entityId, ADA_ID, "and the account that was read");
  expectDeepEqual(harness.audit.entries[0]?.payload, { live_sessions: 4 }, "with the count it read");

  const otherOfficer = harnessOf();

  await readAccountSessions({ actor: ceo, query: "ada@example.test" }, otherOfficer.dependencies);
  expectEqual(otherOfficer.audit.entries[0]?.actorUserId, CEO_ID, "a different officer is named as themselves");

  const emptyAccount = harnessOf();

  emptyAccount.database.tables["sessions"] = [];

  const empty = await readAccountSessions({ actor: desk, query: ADA_ID }, emptyAccount.dependencies);

  expectEqual(empty?.counts.live, 0, "an account with no session counts none");
  expectEqual(empty?.sessions.length, 0, "and lists none");
  expectDeepEqual(
    empty?.counts,
    { live: 0, trustedDevices: 0, unconfirmedDevices: 0, droppedDevices: 0 },
    "with every count at zero",
  );

  expectEqual(harness.database.writes.length, 0, "reading a list writes nothing");
}

/**
 * Markers a committed file may not carry, assembled from parts so that this gate - which is scanned
 * by the structure gate in turn - does not trip the very rule it enforces.
 */
const logMarker = ["console", "log"].join(".");

const forbiddenMarkers: readonly string[] = [
  ["TO", "DO"].join(""),
  ["FIX", "ME"].join(""),
  logMarker,
];

/** ---- The sources: the page, the console, the entry and the deep screen it opens. */
async function checkSources(): Promise<void> {
  const page = await readRepositoryFile("app/(admin)/account-sessions/page.tsx");
  const console_ = await readRepositoryFile("app/(admin)/account-sessions/office-session-console.tsx");
  const consoleModule = await readRepositoryFile("app/(admin)/account-sessions/session-console.ts");
  const navigation = await readRepositoryFile("components/office/navigation.ts");
  const deepScreen = await readRepositoryFile("app/office/sessions/page.tsx");

  expectEqual(
    page.split("\n")[0],
    "// path: app/(admin)/account-sessions/page.tsx",
    "the page states its path",
  );
  expectEqual(
    console_.split("\n")[0],
    "// path: app/(admin)/account-sessions/office-session-console.tsx",
    "and so does the console",
  );
  expectEqual(
    consoleModule.split("\n")[0],
    "// path: app/(admin)/account-sessions/session-console.ts",
    "and the module",
  );
  expectEqual(console_.split("\n")[1], '"use client";', "the console is a client component");
  expectEqual(page.includes('"use client"'), false, "and the page is not");

  for (const [label, source] of [
    ["page", page],
    ["console", console_],
    ["module", consoleModule],
  ] as const) {
    expectEqual(/[^\t\n\r\x20-\x7E]/u.test(source), false, `the ${label} is ASCII only`);
    for (const marker of forbiddenMarkers) {
      expectEqual(source.includes(marker), false, `the ${label} carries no ${marker === logMarker ? "log" : "placeholder"} marker`);
    }

    expectEqual(/:\s*any\b|as any\b/u.test(source), false, `the ${label} names no any`);
    expectEqual(source.includes("process.env"), false, `the ${label} reads no environment`);
  }

  // The rule is STEP 054's constant, imported rather than restated.
  expect(consoleModule.includes("SESSION_MANAGEMENT_OFFICE_ROLES"), "the module imports the session roles");
  expect(consoleModule.includes("requireAnyRole("), "and asks them before its first query");
  expect(consoleModule.includes("listAccountSessions("), "then hands the read to STEP 054");
  expectEqual(
    /revokeAccountSession\(/u.test(consoleModule),
    false,
    "the module writes nothing: the revoke is STEP 054's route",
  );
  expectEqual(consoleModule.includes(".update("), false, "and touches no row");
  expectEqual(page.includes("SESSION_MANAGEMENT_OFFICE_ROLES"), false, "the page holds no role list");
  expectEqual(console_.includes("SESSION_MANAGEMENT_OFFICE_ROLES"), false, "and neither does the console");
  expectEqual(
    /(super_admin|compliance_kyc|finance_ops)/u.test(page) || /(super_admin|compliance_kyc|finance_ops)/u.test(console_),
    false,
    "no screen names a role identifier",
  );

  // The search is a plain GET back to the page.
  expect(page.includes('method="get"'), "the search is a GET");
  expect(page.includes('action="/account-sessions"'), "back to this screen");
  expect(page.includes('name="q"'), "carrying one field");
  expect(page.includes("maxLength={SESSION_SEARCH_MAXIMUM_LENGTH}"), "bounded by the module's ceiling");
  expect(page.includes("readAccountSessions("), "and read through the module");
  expect(page.includes('href="/account-sessions"'), "with a way to clear it");

  // The act is one route, one request per session.
  expectEqual(
    (console_.match(/REVOKE_PATH = "\/api\/office\/sessions\/revoke"/u) ?? []).length,
    1,
    "the console posts to STEP 054's revoke route",
  );
  expectEqual(
    (console_.match(/fetch\(/gu) ?? []).length,
    2,
    "with two fetch sites: one session, and every session",
  );
  expectEqual(
    (console_.match(/fetch\(REVOKE_PATH/gu) ?? []).length,
    2,
    "both of them the same route",
  );
  expect(console_.includes("deviceProofHeaders("), "the device proof is sent, STEP 050's");
  expect(console_.includes("csrfHeaders()"), "and the CSRF token");
  expect(console_.includes("REAUTHENTICATION_REQUIRED_RULE"), "a missing second factor confirmation is told apart");
  expect(console_.includes('href="/reauth"'), "and links to STEP 053's window");
  expect(console_.includes("for (const session of sessions)"), "the bulk action is one request per session, in turn");
  expect(console_.includes("router.refresh()"), "and the list is re-read from the server afterwards");
  expectEqual(
    /\/api\/(?!office\/sessions\/revoke)/u.test(console_),
    false,
    "the console knows no other endpoint",
  );

  // No endpoint and no migration was added by this STEP.
  const apiOffice = await readdir(new URL("app/api/office/", repositoryRoot));

  expectEqual(apiOffice.includes("account-sessions"), false, "this STEP adds no endpoint under the office API");
  expectEqual(
    (await readdir(new URL("app/api/office/sessions/revoke/", repositoryRoot))).includes("route.ts"),
    true,
    "the revoke route is STEP 054's",
  );

  // The entry points at the screen, and the deep screen is untouched.
  expect(navigation.includes('href: "/account-sessions"'), "the session entry opens this screen");
  expectEqual(navigation.includes('href: "/office/sessions"'), false, "and no longer opens a screen that needs an identifier");
  expect(navigation.includes("roles: SESSION_MANAGEMENT_OFFICE_ROLES"), "with STEP 054's roles on it");
  expect(deepScreen.includes('parameters["userId"]'), "the deep screen still takes an identifier");
  expect(deepScreen.includes("listAccountSessions("), "and still reads through STEP 054");

  const adminScreens = await readdir(new URL("app/(admin)/", repositoryRoot));

  expect(adminScreens.includes("account-sessions"), "the screen lives in the office shell");
  expectEqual(
    (await readdir(new URL("app/office/", repositoryRoot))).includes("account-sessions"),
    false,
    "and not beside the deep screen",
  );
}

/** ---- The catalog: every key once, every key used, no half substituted sentence. */
async function checkCatalog(): Promise<void> {
  const block = en.officeAccountSessions as Record<string, string>;
  const keys = Object.keys(block);
  const page = await readRepositoryFile("app/(admin)/account-sessions/page.tsx");
  const console_ = await readRepositoryFile("app/(admin)/account-sessions/office-session-console.tsx");
  const sources = `${page}\n${console_}`;

  expect(keys.length > 40, "the screen has its own block of copy");
  expectEqual(
    sources.includes("officeAccountSessions."),
    true,
    "and reads its sentences from it",
  );

  for (const key of keys) {
    expect(sources.includes(`"officeAccountSessions.${key}"`), `the copy key ${key} is used by a screen`);

    if (block[key]?.includes("{")) {
      expectEqual(
        sources.includes(`getMessage("officeAccountSessions.${key}")`),
        false,
        `the templated sentence ${key} is never rendered without its values`,
      );
      expect(
        sources.includes(`formatMessage("officeAccountSessions.${key}"`),
        `and is rendered through formatMessage`,
      );
    }
  }

  const referenced = [...sources.matchAll(/officeAccountSessions\.([A-Za-z]+)/gu)].map((match) => match[1]);

  for (const name of new Set(referenced)) {
    expect(
      name !== undefined && Object.prototype.hasOwnProperty.call(block, name),
      `the screens name no missing key (${String(name)})`,
    );
  }

  expectEqual(
    (en.office.sectionSessionsDescription as string).includes("address"),
    true,
    "the navigation entry says the screen takes an address",
  );
}

/** ---- No migration: the indexes the screen reads were created by 0003 and 0010. */
async function checkMigrations(): Promise<void> {
  const files = await readdir(new URL("migrations/", repositoryRoot));
  const numbers = files
    .filter((name) => /^\d{4}_.+\.sql$/u.test(name))
    .map((name) => name.slice(0, 4));

  expectEqual(numbers.includes("0102"), false, "this STEP adds no migration: the indexes already exist");
  expectEqual(Math.max(...numbers.map((number) => Number.parseInt(number, 10))), 101, "the set still ends at 0101");

  const users = await readRepositoryFile("migrations/0003_users.sql");
  const sessions = await readRepositoryFile("migrations/0010_sessions.sql");

  expect(users.includes("create unique index users_email_key on public.users (email)"), "an address is unique on an index");
  expect(
    sessions.includes("create index sessions_user_idx on public.sessions (user_id, revoked_at)"),
    "and one account's live sessions are one index range",
  );
}

async function main(): Promise<void> {
  checkConstants();
  checkSubjectKind();
  await checkRefusals();
  await checkResolution();
  await checkSnapshot();
  await checkSources();
  await checkCatalog();
  await checkMigrations();

  if (failures.length > 0) {
    process.stderr.write(`account session gate failed with ${failures.length} problem(s):\n`);

    for (const failure of failures) {
      process.stderr.write(`  - ${failure}\n`);
    }

    process.exitCode = 1;

    return;
  }

  process.stdout.write(
    `account session gate passed: ${checks} checks, ${SESSION_MANAGEMENT_OFFICE_ROLES.length} session roles, ` +
      `${SESSION_LIST_LIMIT} sessions a screen\n`,
  );
}

await main();
