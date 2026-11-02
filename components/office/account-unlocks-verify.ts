// path: components/office/account-unlocks-verify.ts
import { readdir, readFile } from "node:fs/promises";
import process from "node:process";
import type { z } from "zod";
import {
  ACCOUNT_UNLOCK_NOTE_MAX_LENGTH,
  ACCOUNT_UNLOCK_OFFICE_ROLES,
} from "../../lib/auth/account-unlock.ts";
import type { RestClient } from "../../lib/auth/rest.ts";
import type { PlatformRole, RequestActor } from "../../lib/auth/types.ts";
import { formatMessage, getMessage, type MessagePath } from "../../lib/i18n/messages.ts";
import { en } from "../../lib/i18n/strings/en.ts";
import {
  ACCOUNT_LOCK_FACTORS,
  ACCOUNT_LOCK_NOTE_MAXIMUM_LENGTH,
  ACCOUNT_LOCK_QUEUE_LIMIT,
  ACCOUNT_LOCK_RECENT_LIMIT,
  listAccountLocks,
  lockFactorLabelKey,
  lockStandingLabelKey,
  lockStandingOf,
  remainingSecondsOf,
  type AccountLockQueue,
} from "../../app/(admin)/account-unlocks/account-locks.ts";

/**
 * The account unlock screen gate: run with `node components/office/account-unlocks-verify.ts`.
 *
 * Section 22's screen is four sentences, and each one is a property no page can show:
 *
 *   1. **A permitted office role reads it.** `ACCOUNT_UNLOCK_OFFICE_ROLES` and a satisfied second
 *      factor are asked before the first query, with the same two functions `unlockAccountLock` uses,
 *      so a role that could not end a lock cannot read one either - and the screen needs no copy of
 *      the rule.
 *   2. **The queue is every open lock, oldest first.** The rows are the partial set
 *      `unlocked_at is null and expired_at is null`, ordered by `locked_at`, capped at fifty - which is
 *      the index `0101` adds.
 *   3. **A lapsed row is shown and never offered.** A lock whose two hours are over is printed as
 *      "the time is up" with no button, because `unlockAccountLock` refuses it with `CONFLICT`.
 *   4. **The act is STEP 047's.** The screen posts to one route, that route carries the CSRF token,
 *      the device proof and the fresh-reauthentication guard, and the module writes nothing at all.
 *
 * The module runs over an in-memory PostgREST with the four methods `RestClient` exposes, so what
 * passes here is the code the page runs. The page, the client console, the navigation entry and the
 * migration are read as source, because a `.tsx` file cannot be imported by plain Node.
 *
 * ## What it cannot prove
 *
 * That PostgREST is reachable, that `0101` was applied to a particular project, and that a person can
 * press the button at two widths - those are deployment and browser facts, and the handoff lists the
 * checks a person runs against a real project.
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
const LOCK_LAPSED_ID = "018f2b8a-7777-4c2d-9c3e-000000000001";
const LOCK_SOON_ID = "018f2b8a-7777-4c2d-9c3e-000000000002";
const LOCK_LIVE_ID = "018f2b8a-7777-4c2d-9c3e-000000000003";
const LOCK_UNLOCKED_ID = "018f2b8a-7777-4c2d-9c3e-000000000004";

const LAPSED_USER = "018f2b8a-5555-4c2d-9c3e-000000000001";
const SOON_USER = "018f2b8a-5555-4c2d-9c3e-000000000002";
const LIVE_USER = "018f2b8a-5555-4c2d-9c3e-000000000003";
const MISSING_USER = "018f2b8a-5555-4c2d-9c3e-000000000004";

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

/** The roles and accounts the screen must refuse. */
const refusedActors: readonly (readonly [string, RequestActor])[] = [
  ["finance_ops", actorOf(["finance_ops"], { userId: FINANCE_ID })],
  ["blogger", actorOf(["blogger"], { userId: BLOGGER_ID })],
  ["owner", actorOf(["owner"], { userId: LIVE_USER, companyId: COMPANY_ID })],
  ["nobody", actorOf([])],
  [
    "an officer who still owes a second factor",
    actorOf(["support"], { userId: SUPPORT_ID, twoFactorSatisfied: false }),
  ],
  [
    "an officer who has not enrolled yet",
    actorOf(["support"], { userId: SUPPORT_ID, twoFactorEnrolmentRequired: true }),
  ],
];

type Row = Record<string, unknown>;

/** The four lock rows a seeded office would hold, and the three accounts behind them. */
function lockRows(): Row[] {
  return [
    {
      id: LOCK_LAPSED_ID,
      user_id: LAPSED_USER,
      company_id: null,
      triggered_by: "password",
      locked_at: "2026-11-02T07:00:00.000Z",
      expires_at: "2026-11-02T09:00:00.000Z",
      owner_alerted_at: "2026-11-02T07:00:05.000Z",
      owner_contact_confirmed_at: null,
      unlocked_at: null,
      unlocked_by: null,
      unlock_note: null,
      expired_at: null,
      deleted_at: null,
    },
    {
      id: LOCK_SOON_ID,
      user_id: SOON_USER,
      company_id: COMPANY_ID,
      triggered_by: "totp",
      locked_at: "2026-11-02T08:00:00.000Z",
      expires_at: "2026-11-02T10:30:30.000Z",
      owner_alerted_at: null,
      owner_contact_confirmed_at: "2026-11-02T10:10:00.000Z",
      unlocked_at: null,
      unlocked_by: null,
      unlock_note: null,
      expired_at: null,
      deleted_at: null,
    },
    {
      id: LOCK_LIVE_ID,
      user_id: LIVE_USER,
      company_id: COMPANY_ID,
      triggered_by: "password",
      locked_at: "2026-11-02T10:00:00.000Z",
      expires_at: "2026-11-02T12:00:00.000Z",
      owner_alerted_at: "2026-11-02T10:00:02.000Z",
      owner_contact_confirmed_at: null,
      unlocked_at: null,
      unlocked_by: null,
      unlock_note: null,
      expired_at: null,
      deleted_at: null,
    },
    {
      id: LOCK_UNLOCKED_ID,
      user_id: MISSING_USER,
      company_id: null,
      triggered_by: "totp",
      locked_at: "2026-11-02T05:00:00.000Z",
      expires_at: "2026-11-02T07:00:00.000Z",
      owner_alerted_at: "2026-11-02T05:00:01.000Z",
      owner_contact_confirmed_at: "2026-11-02T09:00:00.000Z",
      unlocked_at: "2026-11-02T09:15:00.000Z",
      unlocked_by: OFFICER_ID,
      unlock_note: "Called the owner on the number on file and confirmed by email.",
      expired_at: null,
      deleted_at: null,
    },
  ];
}

function accountRows(): Row[] {
  return [
    { id: LAPSED_USER, email: "lapsed@example.test", full_name: "Lapsed Owner", deleted_at: null },
    { id: SOON_USER, email: "soon@example.test", full_name: "Soon Owner", deleted_at: null },
    { id: LIVE_USER, email: "live@example.test", full_name: "Live Owner", deleted_at: null },
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

/** The operators this module's queries use: `eq`, `is.null`, `not.is.null` and `in.(...)`. */
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

function createDatabase(rows: Row[] = lockRows()): FakeDatabase {
  return {
    tables: { account_locks: rows, users: accountRows() },
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

      return Promise.reject(new Error("the unlock screen never inserts"));
    },
    insertReturning(table: string): Promise<never> {
      database.writes.push(`insertReturning ${table}`);

      return Promise.reject(new Error("the unlock screen never inserts"));
    },
    update(table: string): Promise<void> {
      database.writes.push(`update ${table}`);

      return Promise.reject(new Error("the unlock act belongs to STEP 047, not to this screen"));
    },
    rpc(name: string): Promise<unknown> {
      database.writes.push(`rpc ${name}`);

      return Promise.reject(new Error("the unlock screen calls no function"));
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

function dependenciesOf(database: FakeDatabase): { readonly rest: RestClient; readonly now: () => number } {
  return { rest: createStore(database), now: (): number => NOW };
}

/** ---- The constants and the two pure functions. */
function checkConstants(): void {
  expectEqual(
    ACCOUNT_UNLOCK_OFFICE_ROLES.join(","),
    "super_admin,ceo,compliance_kyc,support",
    "four office roles may end a lock, as STEP 047 decided",
  );
  expectEqual(ACCOUNT_LOCK_QUEUE_LIMIT, 50, "the queue carries fifty open locks");
  expectEqual(ACCOUNT_LOCK_RECENT_LIMIT, 20, "and the record carries twenty closures");
  expectEqual(ACCOUNT_LOCK_NOTE_MAXIMUM_LENGTH, ACCOUNT_UNLOCK_NOTE_MAX_LENGTH, "the note ceiling is the column's");
  expectEqual(ACCOUNT_LOCK_NOTE_MAXIMUM_LENGTH, 280, "which is 280 characters");
  expectDeepEqual([...ACCOUNT_LOCK_FACTORS], ["password", "totp"], "the two factors are the column's values");

  for (const role of ACCOUNT_UNLOCK_OFFICE_ROLES) {
    expect(role === "super_admin" || role === "ceo" || role === "compliance_kyc" || role === "support", `${role} is an office role`);
  }

  expectEqual(lockStandingOf("2026-11-02T12:00:00.000Z", NOW), "open", "a lock inside its two hours is open");
  expectEqual(lockStandingOf("2026-11-02T10:30:00.000Z", NOW), "lapsed", "a lock at its exact expiry is lapsed");
  expectEqual(lockStandingOf("2026-11-02T09:00:00.000Z", NOW), "lapsed", "and one that passed is lapsed");
  expectEqual(lockStandingOf("not a date", NOW), "lapsed", "and an unreadable expiry fails closed");

  expectEqual(remainingSecondsOf("2026-11-02T12:00:00.000Z", NOW), 5_400, "the wait is counted in whole seconds");
  expectEqual(remainingSecondsOf("2026-11-02T10:30:30.000Z", NOW), 30, "which can be under a minute");
  expectEqual(remainingSecondsOf("2026-11-02T09:00:00.000Z", NOW), 0, "and never goes below zero");
  expectEqual(remainingSecondsOf("not a date", NOW), 0, "an unreadable expiry has no wait");
}

/** ---- The labels the screen prints. */
function checkLabels(): void {
  for (const factor of ACCOUNT_LOCK_FACTORS) {
    const key = lockFactorLabelKey(factor);

    expect(key === "officeUnlock.factorPassword" || key === "officeUnlock.factorTotp", `${factor} has its own key`);
    expect(getMessage(key).length > 0, `${factor} has a name`);
  }

  expectEqual(lockFactorLabelKey("password"), "officeUnlock.factorPassword", "the password factor is named");
  expectEqual(lockFactorLabelKey("totp"), "officeUnlock.factorTotp", "and the code factor");
  expectEqual(lockStandingLabelKey("open"), "officeUnlock.standingOpen", "an open lock says so");
  expectEqual(lockStandingLabelKey("lapsed"), "officeUnlock.standingLapsed", "and a lapsed one says the time is up");
  expectEqual(
    getMessage(lockStandingLabelKey("open")) === getMessage(lockStandingLabelKey("lapsed")),
    false,
    "the two standings are two sentences",
  );
}

/** ---- The two lists. */
async function checkQueue(): Promise<void> {
  const database = createDatabase();
  const queue: AccountLockQueue = await listAccountLocks({ actor: supervisor }, dependenciesOf(database));

  expectEqual(queue.open.length, 3, "three locks are still open");
  expectDeepEqual(
    queue.open.map((lock) => lock.id),
    [LOCK_LAPSED_ID, LOCK_SOON_ID, LOCK_LIVE_ID],
    "oldest first, because the person waiting longest is owed the answer",
  );
  expectEqual(queue.closed.length, 1, "one lock was closed by the office");
  expectEqual(queue.closed[0]?.id, LOCK_UNLOCKED_ID, "and it is that row");
  expectEqual(queue.closed[0]?.unlockNote?.length, 62, "with the note the officer wrote");
  expectEqual(queue.closed[0]?.unlockedBy, OFFICER_ID, "and the officer who wrote it");
  expectEqual(queue.readAtEpochMs, NOW, "the queue says when it was read");
  expectEqual(queue.queueLimit, 50, "and how many rows it may carry");
  expectEqual(queue.recentLimit, 20, "and how many closures it may carry");

  expectDeepEqual(
    queue.open.map((lock) => lock.standing),
    ["lapsed", "open", "open"],
    "a lapsed row is told apart from an open one",
  );
  expectDeepEqual(
    queue.open.map((lock) => lock.unlockable),
    [false, true, true],
    "and only an open lock offers the act the service accepts",
  );
  expectDeepEqual(
    queue.open.map((lock) => lock.remainingSeconds),
    [0, 30, 5_400],
    "each row carries the wait it has left",
  );

  const lapsed = queue.open[0];
  const soon = queue.open[1];
  const live = queue.open[2];

  expectEqual(lapsed?.ownerAlerted, true, "the owner was told about the lapsed lock");
  expectEqual(soon?.ownerAlerted, false, "and not about the one that is still open");
  expectEqual(soon?.ownerContactConfirmedAt, "2026-11-02T10:10:00.000Z", "a recorded contact keeps its instant");
  expectEqual(live?.ownerContactConfirmedAt, null, "and a row nobody called has none");
  expectEqual(live?.account?.email, "live@example.test", "the account behind a lock is joined");
  expectEqual(live?.account?.fullName, "Live Owner", "with its name");
  expectEqual(soon?.companyId, COMPANY_ID, "the company of a merchant lock is printed");
  expectEqual(queue.closed[0]?.account, null, "a lock whose account row is gone is still listed");

  expectEqual(database.queries.length, 3, "three reads: the open locks, the closures, and the accounts");
  expect(database.queries[0]?.startsWith("account_locks?") === true, "the queue reads the lock table");
  expectEqual(
    database.queries[0]?.includes("unlocked_at=is.null&expired_at=is.null&deleted_at=is.null"),
    true,
    "the queue is the open set and nothing else",
  );
  expectEqual(database.queries[0]?.includes("order=locked_at.asc"), true, "oldest first, as the index is built");
  expectEqual(database.queries[0]?.includes("limit=50"), true, "capped at fifty");
  expectEqual(database.queries[1]?.includes("unlocked_at=not.is.null"), true, "the record is the unlocked set");
  expectEqual(database.queries[1]?.includes("order=unlocked_at.desc"), true, "newest closure first");
  expectEqual(database.queries[1]?.includes("limit=20"), true, "capped at twenty");
  expect(database.queries[2]?.startsWith("users?") === true, "the third read is the accounts");
  expectEqual(database.queries[2]?.includes("deleted_at=is.null"), true, "and it skips a soft closed account");
  expectEqual(database.queries[2]?.includes("SELECT=id,email,full_name"), false, "it selects only what the screen prints");
  expectEqual(database.queries[2]?.includes("select=id,email,full_name"), true, "which is the identifier, the address and the name");
  expectEqual(database.writes.length, 0, "and nothing is written");

  const empty = createDatabase([]);
  empty.tables["users"] = [];

  const emptyQueue = await listAccountLocks({ actor: supervisor }, dependenciesOf(empty));

  expectEqual(emptyQueue.open.length, 0, "an office with nothing locked gets an empty queue");
  expectEqual(emptyQueue.closed.length, 0, "and an empty record");
  expectEqual(empty.queries.length, 2, "with no account read at all");
  expectEqual(emptyQueue.readAtEpochMs, NOW, "and still knows when it was read");

  for (const [name, actor] of [
    ["ceo", ceo],
    ["the compliance desk", desk],
    ["support", support],
  ] as const) {
    const allowed = createDatabase();
    const answer = await listAccountLocks({ actor }, dependenciesOf(allowed));

    expectEqual(answer.open.length, 3, `${name} reads the queue`);
    expectEqual(allowed.writes.length, 0, `and ${name} writes nothing`);
  }

  for (const [name, actor] of refusedActors) {
    const refused = createDatabase();
    const code = await failureOf(() => listAccountLocks({ actor }, dependenciesOf(refused)));

    expectEqual(code, "PERMISSION_DENIED", `${name} is refused the queue`);
    expectEqual(refused.queries.length, 0, `and ${name} causes no query at all`);
  }
}

/** ---- The sources: the page, the console, the navigation entry and the act. */
async function collectSources(): Promise<Readonly<Record<string, string>>> {
  return {
    "app/(admin)/account-unlocks/account-locks.ts": await readRepositoryFile(
      "app/(admin)/account-unlocks/account-locks.ts",
    ),
    "app/(admin)/account-unlocks/page.tsx": await readRepositoryFile(
      "app/(admin)/account-unlocks/page.tsx",
    ),
    "app/(admin)/account-unlocks/office-unlock-queue.tsx": await readRepositoryFile(
      "app/(admin)/account-unlocks/office-unlock-queue.tsx",
    ),
  };
}

async function checkSources(): Promise<void> {
  const sources = await collectSources();

  for (const [path, source] of Object.entries(sources)) {
    expectEqual(source.split("\n")[0], `// path: ${path}`, `${path} states its own path on its first line`);
    expectEqual(source.includes("dangerouslySetInnerHTML"), false, `${path} writes no markup from a string`);
    expectEqual(source.includes("console."), false, `${path} logs nothing`);
    expectEqual(source.includes("process.env"), false, `${path} reads no environment variable`);
    expectEqual(/:\s*any\b/u.test(source), false, `${path} writes no any`);
    expectEqual(/https?:\/\//u.test(source), false, `${path} names no absolute URL`);
    expectEqual(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\uFFFF]/u.test(source), false, `${path} is ASCII`);
    expectEqual(source.includes("super_admin"), false, `${path} names no role: the auth module owns that list`);
  }

  const queueSource = sources["app/(admin)/account-unlocks/account-locks.ts"] ?? "";
  const page = sources["app/(admin)/account-unlocks/page.tsx"] ?? "";
  const console_ = sources["app/(admin)/account-unlocks/office-unlock-queue.tsx"] ?? "";

  expect(queueSource.includes("ACCOUNT_UNLOCK_OFFICE_ROLES"), "the module imports the unlock role list");
  expect(queueSource.includes("hasSatisfiedTwoFactor"), "and asks the second factor question of the same module");
  expect(queueSource.includes("requireAnyRole"), "with the shared permission helper");
  expectEqual(queueSource.includes("unlockAccountLock("), false, "and never calls the act itself");
  expectEqual(/roles:\s*\[/u.test(queueSource), false, "no role list is spelled out");

  expect(page.includes("listAccountLocks("), "the page reads the queue through the module");
  expectEqual(page.includes("requireAnyRole"), false, "and holds no permission check of its own");
  expect(page.includes('"PERMISSION_DENIED"'), "it words the service's refusal");
  expect(page.includes("readOfficeActor"), "and reads the account from the cached reader");
  expect(page.includes("<OfficeUnlockQueue"), "it hands the open rows to the console");
  expect(page.includes('href="/admin"'), "and links back to the workspace");

  expect(console_.includes('"use client"'), "the console is a client component");
  expect(console_.includes('const UNLOCK_PATH = "/api/office/account-locks/unlock"'), "it posts to STEP 047's route");
  expect(console_.includes("deviceProofHeaders("), "with the device proof of STEP 050");
  expect(console_.includes("csrfHeaders("), "and the CSRF token of STEP 057");
  expect(console_.includes("REAUTHENTICATION_REQUIRED_RULE"), "and it tells the reauthentication window from a refusal");
  expect(console_.includes('href="/reauth"'), "by offering the reauthentication screen");
  expect(console_.includes("router.refresh()"), "and asks the server for the queue it just changed");
  expect(console_.includes("ACCOUNT_LOCK_NOTE_MAXIMUM_LENGTH"), "the note ceiling is the module's, not a number here");
  expect(console_.includes("ownerContactConfirmed: true"), "and the contact is confirmed as a field the service reads");
  expectEqual(console_.includes("requireAnyRole"), false, "the console decides no permission");
  expectEqual(console_.includes("super_admin"), false, "and names no role");

  const routeDirectory = await readdir(new URL("app/api/office/account-locks/", repositoryRoot), {
    recursive: true,
  });

  expectDeepEqual(
    routeDirectory.map((entry) => entry.replaceAll("\\", "/")).sort(),
    ["unlock", "unlock/route.ts"],
    "there is exactly one route under the unlock path, and it is STEP 047's",
  );

  const route = await readRepositoryFile("app/api/office/account-locks/unlock/route.ts");

  expect(route.includes("requireCsrfToken("), "the route the screen posts to checks the token");
  expect(route.includes("verifySensitiveRequest("), "and the request proof");
  expect(route.includes("requireTrustedDevice("), "over a trusted device");
  expect(route.includes("requireFreshReauthentication("), "with the fresh reauthentication of section 22");
  expect(route.includes("unlockAccountLock("), "before the one service call that decides everything");

  const navigation = await readRepositoryFile("components/office/navigation.ts");

  expect(navigation.includes('key: "accountUnlocks"'), "the sidebar carries the unlock screen");
  expect(navigation.includes('href: "/account-unlocks"'), "at the address the page is served at");
  expect(navigation.includes("ACCOUNT_UNLOCK_OFFICE_ROLES"), "with the role list imported rather than restated");
}

/** ---- The copy: every key printed, and every printed key in the catalog. */
async function checkCatalog(): Promise<void> {
  const catalogKeys = new Set(Object.keys(en.officeUnlock));
  const sources = await collectSources();
  const used = new Set<string>();
  const pattern = /officeUnlock\.([a-zA-Z0-9]+)/gu;

  for (const source of Object.values(sources)) {
    for (const match of source.matchAll(pattern)) {
      const key = match[1];

      if (key !== undefined) {
        used.add(key);
      }
    }
  }

  for (const key of used) {
    expect(catalogKeys.has(key), `officeUnlock.${key} is in the catalog`);
  }

  for (const key of catalogKeys) {
    expect(used.has(key), `officeUnlock.${key} is printed somewhere in the screen`);
  }

  const templates = en.officeUnlock as Readonly<Record<string, string>>;

  for (const key of used) {
    if (!catalogKeys.has(key)) {
      continue;
    }

    const template = templates[key];
    const path = `officeUnlock.${key}` as MessagePath;

    expect(typeof template === "string" && template.length > 0, `${path} is not empty`);
    expectEqual(template?.trim(), template, `${path} is trimmed`);

    const placeholders = [...(template ?? "").matchAll(/\{([a-zA-Z][a-zA-Z0-9]*)\}/gu)].map(
      (match) => match[1] ?? "",
    );
    const withoutPlaceholders = (template ?? "").replace(/\{[a-zA-Z][a-zA-Z0-9]*\}/gu, "");

    expectEqual(/[{}]/u.test(withoutPlaceholders), false, `${path} has whole placeholders only`);

    const filled = formatMessage(
      path,
      Object.fromEntries(placeholders.map((name) => [name, "x"])),
    );

    expectEqual(filled.includes("{"), false, `${path} is filled by the values the screen passes`);
  }

  expectEqual(getMessage("officeUnlock.title"), "Account unlocks", "the screen names itself in words");
  expectEqual(getMessage("officeUnlock.eyebrow"), "Platform office", "and names itself as the platform side");
  expect(getMessage("office.sectionAccountUnlocks").length > 0, "the sidebar label is in the catalog");
  expect(getMessage("office.sectionAccountUnlocksDescription").length > 0, "and so is its description");
}

/** ---- The migration: two partial indexes, additive, with a rollback beside them. */
async function checkMigration(): Promise<void> {
  const files = await readdir(new URL("migrations/", repositoryRoot));
  const thisOne = files.filter((name) => name.startsWith("0101_"));

  expectEqual(thisOne.length, 2, "the migration and its rollback are the two files numbered 0101");
  expect(thisOne.includes("0101_account_lock_queue_indexes.sql"), "the migration is the queue indexes");
  expect(thisOne.includes("0101_account_lock_queue_indexes.down.sql"), "and the rollback is beside it");

  const up = await readRepositoryFile("migrations/0101_account_lock_queue_indexes.sql");
  const down = await readRepositoryFile("migrations/0101_account_lock_queue_indexes.down.sql");

  expectEqual(up.split("\n")[0], "-- path: migrations/0101_account_lock_queue_indexes.sql", "the migration states its path");
  expectEqual(down.split("\n")[0], "-- path: migrations/0101_account_lock_queue_indexes.down.sql", "and so does the rollback");
  expect(up.includes("account_lock_queue_idx"), "the queue index is created");
  expect(up.includes("account_lock_recent_idx"), "and the closure index");
  expect(
    up.includes("where unlocked_at is null and expired_at is null and deleted_at is null"),
    "the queue index is the partial open set the query reads",
  );
  expect(
    up.includes("on public.account_locks (locked_at)"),
    "ordered the way the queue is ordered",
  );
  expectEqual(up.includes("create table"), false, "no table is created");
  expectEqual(up.includes("create policy"), false, "and no policy is written");
  expectEqual(/update\s+account_locks/iu.test(up), false, "no row is touched");
  expect(down.includes("drop index if exists public.account_lock_queue_idx"), "the rollback drops the queue index");
  expect(down.includes("drop index if exists public.account_lock_recent_idx"), "and the closure index");
  expectEqual(down.includes("account_locks_live_key"), false, "while the one open lock rule stays");
}

async function main(): Promise<void> {
  checkConstants();
  checkLabels();
  await checkQueue();
  await checkSources();
  await checkCatalog();
  await checkMigration();

  if (failures.length > 0) {
    process.stderr.write(`account unlock gate failed with ${failures.length} problem(s):\n`);

    for (const failure of failures) {
      process.stderr.write(`  - ${failure}\n`);
    }

    process.exitCode = 1;

    return;
  }

  process.stdout.write(
    `account unlock gate passed: ${checks} checks, ${ACCOUNT_UNLOCK_OFFICE_ROLES.length} unlock roles, ` +
      `${ACCOUNT_LOCK_QUEUE_LIMIT} open locks a queue\n`,
  );
}

await main();
