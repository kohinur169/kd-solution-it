// path: lib/audit-log/verify.ts
import { readdir, readFile } from "node:fs/promises";
import process from "node:process";
import type { z } from "zod";
import { PLATFORM_CHAIN_ID } from "../auth/audit.ts";
import { PLATFORM_ROLES, type PlatformRole, type RequestActor } from "../auth/types.ts";
import { formatMessage, getMessage, type MessagePath } from "../i18n/messages.ts";
import { en } from "../i18n/strings/en.ts";
import {
  AUDIT_LOG_ACTION_PREFIX_PATTERN,
  AUDIT_LOG_ENTITY_TYPE_PATTERN,
  AUDIT_LOG_HASH_PREVIEW_LENGTH,
  AUDIT_LOG_MAXIMUM_OFFSET,
  AUDIT_LOG_MAXIMUM_RANGE_DAYS,
  AUDIT_LOG_PAGE_SIZE,
  AUDIT_LOG_PAYLOAD_PREVIEW_MAXIMUM,
  AUDIT_LOG_READ_ROLES,
  AUDIT_LOG_SCREEN_ROLES,
  AUDIT_LOG_USER_AGENT_PREVIEW_MAXIMUM,
  AUDIT_PLATFORM_COMPANY_PARAMETER,
  EMPTY_AUDIT_FILTERS,
  auditDayOf,
  auditFieldLabelKey,
  auditProblemMessageKey,
  auditQueryStringOf,
  endOfDayExclusiveEpochMs,
  hasAuditFilters,
  isUuid,
  parseAuditQuery,
  startOfDayEpochMs,
  type AuditFilterProblem,
  type AuditFilters,
} from "./registry.ts";
import {
  auditQueryOf,
  listAuditEntries,
  verifyAuditChain,
  type AuditChainVerification,
  type AuditLogDependencies,
  type AuditLogPage,
} from "./service.ts";

/**
 * The audit log viewer gate: run with `node lib/audit-log/verify.ts`.
 *
 * Section 33's viewer is four sentences, and each one is a property no screen can show:
 *
 *   1. **Three roles read the log.** `0074` grants the select to the super administrator, the chief
 *      executive and the compliance desk, and the module refuses every other role before its first
 *      query - so a screen cannot read a row the policy would have refused.
 *   2. **A filter is applied whole or not at all.** Every value is checked against the shape its field
 *      declares; a value that fails is reported and dropped rather than approximated. The gate proves
 *      the refusal for each field, and that an empty form really asks for the newest rows of every
 *      chain.
 *   3. **A page is a window with edges.** At most fifty rows, an offset clamped into the window, and a
 *      "there is more" answer that comes from the fifty first row and not from a second count query.
 *   4. **The viewer reads.** Nothing in the module inserts, updates or removes: the append-only log of
 *      `0013` has no writer here, and the gate runs every scenario over a store that would remember a
 *      write.
 *   5. **The chain check is `0075`'s.** The module asks `audit_verify_chain` and reads its answer; it
 *      does not recompute a hash, because a second definition of the hash is the defect `0013` warns
 *      against.
 *
 * The service runs over an in-memory PostgREST with the five methods `RestClient` exposes, so what
 * passes here is the code the screen runs. The screen, the form and the catalog are read as source,
 * because a `.tsx` file cannot be imported by plain Node.
 *
 * ## What it cannot prove
 *
 * That PostgREST is reachable, that `0100` was applied to a particular project, and that a person can
 * page through the two widths - those are deployment and browser facts, and the handoff lists the
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

/** The instant every scenario runs at. */
const NOW = 1_800_000_000_000;
const NOW_ISO = new Date(NOW).toISOString();

const SUPER_ADMIN_ID = "018f2b8a-1111-4c2d-9c3e-000000000001";
const CEO_ID = "018f2b8a-1111-4c2d-9c3e-000000000002";
const DESK_ID = "018f2b8a-1111-4c2d-9c3e-000000000003";
const FINANCE_ID = "018f2b8a-1111-4c2d-9c3e-000000000004";
const SUPPORT_ID = "018f2b8a-1111-4c2d-9c3e-000000000005";
const BLOGGER_ID = "018f2b8a-1111-4c2d-9c3e-000000000006";

const COMPANY_ID = "018f2b8a-4444-4c2d-9c3e-000000000001";
const OTHER_COMPANY_ID = "018f2b8a-4444-4c2d-9c3e-000000000002";
const ENTITY_ID = "018f2b8a-5555-4c2d-9c3e-000000000001";
const COMPANY_CHAIN_ID = "018f2b8a-6666-4c2d-9c3e-000000000001";

/** An actor record of `lib/auth`, complete so a scenario cannot pass by leaving a field out. */
function actorOf(roles: readonly PlatformRole[], overrides: Partial<RequestActor> = {}): RequestActor {
  return {
    userId: SUPER_ADMIN_ID,
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

const superAdmin = actorOf(["super_admin"]);
const ceo = actorOf(["ceo"], { userId: CEO_ID });
const desk = actorOf(["compliance_kyc"], { userId: DESK_ID });

/** The roles the screen must refuse: everyone who is not one of the three. */
const refusedActors: readonly (readonly [string, RequestActor])[] = [
  ["finance_ops", actorOf(["finance_ops"], { userId: FINANCE_ID })],
  ["support", actorOf(["support"], { userId: SUPPORT_ID })],
  ["blogger", actorOf(["blogger"], { userId: BLOGGER_ID })],
  ["owner", actorOf(["owner"], { userId: BLOGGER_ID, companyId: COMPANY_ID })],
  ["nobody", actorOf([])],
];

type Row = Record<string, unknown>;

interface RowOverrides {
  readonly companyId?: string | null;
  readonly sequence?: number;
  readonly action?: string;
  readonly actorUserId?: string | null;
  readonly entityType?: string | null;
  readonly entityId?: string | null;
  readonly payload?: Readonly<Record<string, unknown>>;
  readonly userAgent?: string | null;
  readonly createdAt?: string;
  readonly hash?: string;
}

/** One `audit_logs` row as PostgREST would return it: every column of `0013`, nothing else. */
function rowOf(index: number, overrides: RowOverrides = {}): Row {
  const companyId = overrides.companyId === undefined ? null : overrides.companyId;

  return {
    id: `018f2b8a-7777-4c2d-9c3e-${String(index).padStart(12, "0")}`,
    company_id: companyId,
    chain_id: companyId === null ? PLATFORM_CHAIN_ID : COMPANY_CHAIN_ID,
    sequence: overrides.sequence ?? index,
    actor_user_id: overrides.actorUserId === undefined ? SUPER_ADMIN_ID : overrides.actorUserId,
    action: overrides.action ?? "session.started",
    entity_type: overrides.entityType === undefined ? "session" : overrides.entityType,
    entity_id: overrides.entityId === undefined ? ENTITY_ID : overrides.entityId,
    payload: overrides.payload ?? { note: "recorded" },
    session_id: "018f2b8a-2222-4c2d-9c3e-000000000001",
    ip_address: "203.0.113.10",
    user_agent: overrides.userAgent === undefined ? "Mozilla/5.0" : overrides.userAgent,
    prev_hash: "0".repeat(64),
    hash: overrides.hash ?? index.toString(16).padStart(64, "a"),
    signature: "c2lnbmF0dXJl",
    signing_key_id: "ed25519-platform-1",
    created_at: overrides.createdAt ?? NOW_ISO,
  };
}

interface Filter {
  readonly column: string;
  readonly operator: "eq" | "isNull" | "like" | "gte" | "lt";
  readonly value: string;
}

interface ParsedQuery {
  readonly filters: readonly Filter[];
  readonly limit: number;
  readonly offset: number;
  readonly order: readonly (readonly [string, "asc" | "desc"])[];
}

/** The operators this module's queries use, and no others: a new one must be taught here first. */
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
      filters.push({ column, operator: "isNull", value: "" });
      continue;
    }

    if (expression.startsWith("eq.")) {
      filters.push({ column, operator: "eq", value: decodeURIComponent(expression.slice(3)) });
      continue;
    }

    if (expression.startsWith("like.")) {
      filters.push({ column, operator: "like", value: decodeURIComponent(expression.slice(5)) });
      continue;
    }

    if (expression.startsWith("gte.")) {
      filters.push({ column, operator: "gte", value: decodeURIComponent(expression.slice(4)) });
      continue;
    }

    if (expression.startsWith("lt.")) {
      filters.push({ column, operator: "lt", value: decodeURIComponent(expression.slice(3)) });
      continue;
    }

    throw new Error(`the gate's store does not speak this operator: ${part}`);
  }

  return { filters, limit, offset, order };
}

function epochOf(value: unknown): number {
  return Date.parse(String(value ?? ""));
}

function matches(row: Row, filter: Filter): boolean {
  const value = row[filter.column];

  switch (filter.operator) {
    case "isNull":
      return value === null || value === undefined;
    case "eq":
      return String(value ?? "") === filter.value;
    case "like": {
      // PostgREST spells a SQL `%` wildcard as `*`, and this module only ever asks for a prefix.
      const prefix = filter.value.endsWith("*")
        ? filter.value.slice(0, -1)
        : filter.value;

      return String(value ?? "").startsWith(prefix);
    }
    case "gte":
      return epochOf(value) >= epochOf(filter.value);
    default:
      return epochOf(value) < epochOf(filter.value);
  }
}

interface FakeCall {
  readonly name: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}

interface FakeDatabase {
  readonly rows: Row[];
  readonly queries: string[];
  readonly calls: FakeCall[];
  /** Any write this module attempted. The service has none, and this is what proves it. */
  readonly writes: string[];
  verifyAnswer: unknown;
}

function createDatabase(rows: readonly Row[]): FakeDatabase {
  return { rows: [...rows], queries: [], calls: [], writes: [], verifyAnswer: [] };
}

function createDependencies(database: FakeDatabase): AuditLogDependencies {
  return {
    store: {
      select<TRow>(table: string, query: string, schema: z.ZodType<TRow>): Promise<readonly TRow[]> {
        database.queries.push(`${table}?${query}`);

        const { filters, limit, offset, order } = parseFilters(query);

        if (table !== "audit_logs") {
          database.writes.push(`select ${table}`);
        }

        const matched = database.rows.filter((row) =>
          filters.every((filter) => matches(row, filter)),
        );

        for (const [column, direction] of [...order].reverse()) {
          matched.sort((left, right) => {
            const leftValue = column === "created_at" ? epochOf(left[column]) : Number(left[column] ?? 0);
            const rightValue = column === "created_at" ? epochOf(right[column]) : Number(right[column] ?? 0);
            const comparison = leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;

            return direction === "asc" ? comparison : -comparison;
          });
        }

        return Promise.resolve(
          matched.slice(offset, offset + limit).map((row) => schema.parse(row)),
        );
      },
      insert(table: string): Promise<void> {
        database.writes.push(`insert ${table}`);

        return Promise.reject(new Error("the viewer never inserts"));
      },
      insertReturning(table: string): Promise<never> {
        database.writes.push(`insertReturning ${table}`);

        return Promise.reject(new Error("the viewer never inserts"));
      },
      update(table: string): Promise<void> {
        database.writes.push(`update ${table}`);

        return Promise.reject(new Error("the viewer never updates"));
      },
      rpc(name: string, arguments_: Readonly<Record<string, unknown>>): Promise<unknown> {
        database.calls.push({ name, arguments: arguments_ });

        return Promise.resolve(database.verifyAnswer);
      },
    },
    now: (): number => NOW,
  };
}

/** The code a call answered with, or `no-throw`. */
async function failureOf(call: () => Promise<unknown>): Promise<string> {
  try {
    await call();

    return "no-throw";
  } catch (error) {
    const code = (error as { readonly code?: unknown }).code;

    return typeof code === "string" ? code : `defect: ${String(error)}`;
  }
}

/** ---- The roles and the constants. */
function checkConstants(): void {
  expectEqual(
    AUDIT_LOG_READ_ROLES.join(","),
    "ceo,compliance_kyc,super_admin",
    "three roles read the log, in the migration's order",
  );
  expectEqual(
    AUDIT_LOG_SCREEN_ROLES.join(","),
    AUDIT_LOG_READ_ROLES.join(","),
    "the screen is open to exactly the roles the read is",
  );
  expect(Object.isFrozen(AUDIT_LOG_READ_ROLES), "the read role list is frozen");
  expect(Object.isFrozen(AUDIT_LOG_SCREEN_ROLES), "and so is the screen's");

  for (const role of AUDIT_LOG_READ_ROLES) {
    expect(PLATFORM_ROLES.includes(role), `${role} is one of the seven roles of section 2`);
  }

  for (const role of ["finance_ops", "support", "blogger", "owner"] as const) {
    expect(
      !(AUDIT_LOG_READ_ROLES as readonly string[]).includes(role),
      `${role} does not read the log`,
    );
  }

  expectEqual(AUDIT_LOG_PAGE_SIZE, 50, "a page carries fifty rows");
  expectEqual(AUDIT_LOG_MAXIMUM_OFFSET, 2_000, "and an offset stops at two thousand");
  expectEqual(AUDIT_LOG_MAXIMUM_RANGE_DAYS, 366, "a range covers a year at a time");
  expectEqual(AUDIT_LOG_PAYLOAD_PREVIEW_MAXIMUM, 2_000, "a payload preview stops at two thousand characters");
  expectEqual(AUDIT_LOG_USER_AGENT_PREVIEW_MAXIMUM, 160, "a user agent stops at a hundred and sixty");
  expectEqual(AUDIT_LOG_HASH_PREVIEW_LENGTH, 12, "a hash is printed to twelve characters");
  expectEqual(AUDIT_PLATFORM_COMPANY_PARAMETER, "platform", "the platform's own chain is spelled platform");
  expectEqual(PLATFORM_CHAIN_ID, "00000000-0000-0000-0000-000000000000", "and it is the zero uuid");

  expect(AUDIT_LOG_ACTION_PREFIX_PATTERN.test("session."), "an action family may end in a dot");
  expect(AUDIT_LOG_ACTION_PREFIX_PATTERN.test("gateway.key_"), "and may stop inside a family");
  expectEqual(AUDIT_LOG_ACTION_PREFIX_PATTERN.test("Session"), false, "but never starts with a capital");
  expectEqual(AUDIT_LOG_ACTION_PREFIX_PATTERN.test("1session"), false, "nor with a digit");
  expectEqual(AUDIT_LOG_ACTION_PREFIX_PATTERN.test("session..x"), false, "nor repeats a dot");
  expectEqual(AUDIT_LOG_ACTION_PREFIX_PATTERN.test("session/started"), false, "nor carries a slash");

  expect(AUDIT_LOG_ENTITY_TYPE_PATTERN.test("company"), "an entity type is lower case");
  expect(AUDIT_LOG_ENTITY_TYPE_PATTERN.test("gateway_key"), "and may carry an underscore");
  expectEqual(AUDIT_LOG_ENTITY_TYPE_PATTERN.test("Company"), false, "but not a capital");
  expectEqual(AUDIT_LOG_ENTITY_TYPE_PATTERN.test("a".repeat(49)), false, "nor forty nine characters");

  expect(isUuid(COMPANY_ID), "a lower case uuid is an identifier");
  expectEqual(isUuid(COMPANY_ID.toUpperCase()), false, "an upper case one is not");
  expectEqual(isUuid("platform"), false, "and a word is not");
  expectEqual(isUuid(""), false, "nor is nothing");

  expectEqual(hasAuditFilters(EMPTY_AUDIT_FILTERS), false, "an empty filter set is empty");
  expect(Object.isFrozen(EMPTY_AUDIT_FILTERS), "and frozen");
  expect(
    hasAuditFilters({ ...EMPTY_AUDIT_FILTERS, platformOnly: true }),
    "a platform filter is a filter",
  );
  expect(hasAuditFilters({ ...EMPTY_AUDIT_FILTERS, toDay: "2026-11-02" }), "and so is a day");
}

/** Every problem kind and every field kind has a sentence. */
function problemKeys(): readonly AuditFilterProblem[] {
  return [
    { field: "action", rule: "invalid_format" },
    { field: "actor", rule: "invalid_format" },
    { field: "entityType", rule: "invalid_format" },
    { field: "entityId", rule: "invalid_format" },
    { field: "company", rule: "invalid_format" },
    { field: "from", rule: "invalid_date" },
    { field: "to", rule: "invalid_range" },
    { field: "offset", rule: "invalid_format" },
  ];
}

function checkProblemCopy(): void {
  const problems = problemKeys();
  const fields = new Set<string>();
  const sentences = new Set<string>();

  for (const problem of problems) {
    const field = getMessage(auditFieldLabelKey(problem.field));
    const sentence = getMessage(auditProblemMessageKey(problem));

    expect(field.length > 0, `${problem.field} has a name`);
    expect(sentence.length > 0, `${problem.rule} has an explanation`);
    expectEqual(sentence.includes("{"), false, `${problem.rule} needs no value the screen would fill`);
    fields.add(field);
    sentences.add(sentence);
  }

  expectEqual(fields.size, problems.length, "eight fields, eight names: no copy and paste");
  expectEqual(sentences.size, 3, "and three reasons, one per rule");
}

/** ---- Reading a request. */
function checkParsing(): void {
  const empty = parseAuditQuery({});

  expectDeepEqual(empty.filters, EMPTY_AUDIT_FILTERS, "an empty request asks for nothing");
  expectEqual(empty.offset, 0, "from the newest row");
  expectEqual(empty.problems.length, 0, "and reports no problem");

  const full = parseAuditQuery({
    action: "session.",
    actor: SUPER_ADMIN_ID,
    entityType: "session",
    entityId: ENTITY_ID,
    company: COMPANY_ID,
    from: "2026-11-01",
    to: "2026-11-02",
  });

  expectEqual(full.filters.action, "session.", "a dotted prefix is a filter");
  expectEqual(full.filters.actorUserId, SUPER_ADMIN_ID, "so is an actor");
  expectEqual(full.filters.entityType, "session", "an entity type");
  expectEqual(full.filters.entityId, ENTITY_ID, "an entity");
  expectEqual(full.filters.companyId, COMPANY_ID, "and a company");
  expectEqual(full.filters.platformOnly, false, "which is not the platform");
  expectEqual(full.filters.fromDay, "2026-11-01", "the first day of the range");
  expectEqual(full.filters.toDay, "2026-11-02", "and the last");
  expectEqual(full.problems.length, 0, "with nothing refused");

  const upper = parseAuditQuery({ action: "SESSION.", entityType: "Session", company: "PLATFORM" });

  expectEqual(upper.filters.action, "session.", "an action typed in capitals is read in lower case");
  expectEqual(upper.filters.entityType, "session", "and so is an entity type");
  expectEqual(upper.filters.platformOnly, true, "and so is the word platform");

  const spaced = parseAuditQuery({ action: "  session.  ", actor: ` ${SUPER_ADMIN_ID} ` });

  expectEqual(spaced.filters.action, "session.", "surrounding whitespace is trimmed");
  expectEqual(spaced.filters.actorUserId, SUPER_ADMIN_ID, "from every field");

  const arrayed = parseAuditQuery({ action: ["session.", "gateway."], actor: [] });

  expectEqual(arrayed.filters.action, "session.", "a repeated parameter keeps its first value");
  expectEqual(arrayed.filters.actorUserId, null, "and an empty list is an empty field");
  expectEqual(arrayed.problems.length, 0, "without a refusal");

  const platform = parseAuditQuery({ company: "platform" });

  expectEqual(platform.filters.platformOnly, true, "the word platform asks for the platform's chain");
  expectEqual(platform.filters.companyId, null, "and not for a company");

  const refusedAction = parseAuditQuery({ action: "Session Tracker" });

  expectDeepEqual(
    refusedAction.problems,
    [{ field: "action", rule: "invalid_format" }],
    "an action with a space is refused and named",
  );
  expectEqual(refusedAction.filters.action, null, "and is not applied");

  const longAction = parseAuditQuery({ action: `${"a".repeat(64)}.` });

  expectEqual(longAction.problems.length, 1, "an action longer than sixty four characters is refused");
  expectEqual(longAction.filters.action, null, "and not truncated into something else");

  const refusedActor = parseAuditQuery({ actor: "not-a-uuid" });

  expectDeepEqual(
    refusedActor.problems,
    [{ field: "actor", rule: "invalid_format" }],
    "an actor that is not a uuid is refused",
  );
  expectEqual(refusedActor.filters.actorUserId, null, "and not applied");

  expectEqual(
    parseAuditQuery({ entityType: "company-name" }).problems.length,
    1,
    "an entity type with a dash is refused",
  );
  expectEqual(
    parseAuditQuery({ entityId: "42" }).problems.length,
    1,
    "an entity that is not a uuid is refused",
  );
  expectEqual(
    parseAuditQuery({ company: "acme" }).problems.length > 0,
    true,
    "a company that is neither a uuid nor platform is refused",
  );

  const badDay = parseAuditQuery({ from: "2026-02-30" });

  expectDeepEqual(
    badDay.problems,
    [{ field: "from", rule: "invalid_date" }],
    "a day that does not exist is refused",
  );
  expectEqual(badDay.filters.fromDay, null, "and not applied");

  const backwards = parseAuditQuery({ from: "2026-11-02", to: "2026-11-01" });

  expectDeepEqual(
    backwards.problems,
    [{ field: "to", rule: "invalid_range" }],
    "a range that ends before it starts is refused",
  );
  expectEqual(backwards.filters.toDay, null, "by dropping the end");
  expectEqual(backwards.filters.fromDay, "2026-11-02", "and keeping the start");

  const tooLong = parseAuditQuery({ from: "2024-01-01", to: "2026-11-01" });

  expectDeepEqual(
    tooLong.problems,
    [{ field: "from", rule: "invalid_range" }],
    "a range longer than a year is refused",
  );
  expectEqual(tooLong.filters.fromDay, null, "by dropping the start");
  expectEqual(tooLong.filters.toDay, "2026-11-01", "and keeping the end");

  const oneYear = parseAuditQuery({ from: "2025-11-01", to: "2026-11-01" });

  expectEqual(oneYear.problems.length, 0, "a year and a day is still inside the window");
  expectEqual(oneYear.filters.fromDay, "2025-11-01", "so the start is kept");

  const offset = parseAuditQuery({ offset: "100" });

  expectEqual(offset.offset, 100, "an offset is read");
  expectEqual(offset.problems.length, 0, "without a refusal");

  const clamped = parseAuditQuery({ offset: "99999" });

  expectEqual(clamped.offset, AUDIT_LOG_MAXIMUM_OFFSET, "an offset past the window is clamped");
  expectEqual(clamped.problems.length, 0, "and is not a refusal: the page says what it read");

  const negative = parseAuditQuery({ offset: "-5" });

  expectDeepEqual(
    negative.problems,
    [{ field: "offset", rule: "invalid_format" }],
    "a negative offset is refused",
  );
  expectEqual(negative.offset, 0, "and the first page is read instead");

  expectEqual(parseAuditQuery({ offset: "ten" }).problems.length, 1, "a word is not an offset");
  expectEqual(parseAuditQuery({ unknown: "x" }).problems.length, 0, "an unknown parameter is ignored");

  const ordered = parseAuditQuery({ offset: "x", action: "A B", to: "not-a-day" });

  expectDeepEqual(
    ordered.problems.map((problem) => problem.field),
    ["action", "to", "offset"],
    "the refusals come back in the order the form lists them",
  );
}

/** ---- Days, and the query string that carries them. */
function checkDays(): void {
  expectEqual(
    startOfDayEpochMs("2026-11-02"),
    Date.parse("2026-11-02T00:00:00.000Z"),
    "a day starts at midnight UTC",
  );
  expectEqual(
    endOfDayExclusiveEpochMs("2026-11-02"),
    Date.parse("2026-11-03T00:00:00.000Z"),
    "and the range ends just past the day it names, so the day counts whole",
  );
  expectEqual(
    (endOfDayExclusiveEpochMs("2026-11-02") ?? 0) - (startOfDayEpochMs("2026-11-02") ?? 0),
    86_400_000,
    "which is one day",
  );
  expectEqual(startOfDayEpochMs("2026-02-30"), null, "a day that does not exist has no start");
  expectEqual(endOfDayExclusiveEpochMs("2026-13-01"), null, "and no end");
  expectEqual(auditDayOf(startOfDayEpochMs("2026-11-02") ?? 0), "2026-11-02", "and a day is read back");
  expectEqual(auditDayOf(NOW), NOW_ISO.slice(0, 10), "the platform clock is UTC");
}

function checkQueryString(): void {
  expectEqual(auditQueryStringOf(EMPTY_AUDIT_FILTERS, 0), "", "no filters make no string");
  expectEqual(
    auditQueryStringOf(EMPTY_AUDIT_FILTERS, 50),
    "offset=50",
    "and an offset on its own makes one",
  );

  const filters: AuditFilters = {
    action: "session.",
    actorUserId: SUPER_ADMIN_ID,
    entityType: "session",
    entityId: ENTITY_ID,
    companyId: COMPANY_ID,
    platformOnly: false,
    fromDay: "2026-11-01",
    toDay: "2026-11-02",
  };
  const query = auditQueryStringOf(filters, 100);
  const parameters = Object.fromEntries(
    query.split("&").map((part) => {
      const separator = part.indexOf("=");

      return [part.slice(0, separator), decodeURIComponent(part.slice(separator + 1))];
    }),
  );
  const roundTrip = parseAuditQuery(parameters);

  expectDeepEqual(roundTrip.filters, filters, "a filter set survives the round trip through a URL");
  expectEqual(roundTrip.offset, 100, "and so does its offset");
  expectEqual(roundTrip.problems.length, 0, "with nothing refused on the way back");

  expectEqual(
    auditQueryStringOf({ ...EMPTY_AUDIT_FILTERS, platformOnly: true }, 0),
    "company=platform",
    "the platform's chain is spelled platform in the URL",
  );
  expectEqual(
    auditQueryStringOf({ ...EMPTY_AUDIT_FILTERS, companyId: COMPANY_ID }, 0),
    `company=${COMPANY_ID}`,
    "and a company is its identifier",
  );
  expectEqual(
    auditQueryStringOf({ ...EMPTY_AUDIT_FILTERS, action: "a b" }, 0),
    "action=a%20b",
    "a value is encoded rather than spelled into the URL",
  );
}

/** ---- The PostgREST query one page makes. */
function checkQuery(): void {
  const plain = auditQueryOf({ filters: EMPTY_AUDIT_FILTERS, offset: 0, problems: [] }, 51);

  expect(plain.includes("select=id,company_id,chain_id,sequence"), "the page selects the columns it prints");
  expect(plain.includes("deleted_at=is.null"), "it reads the rows that were not removed");
  expect(plain.includes("order=created_at.desc,sequence.desc"), "newest first, and by sequence within one instant");
  expect(plain.includes("limit=51"), "asking for one row more than it shows");
  expect(plain.includes("offset=0"), "from the top");
  expectEqual(plain.includes("action="), false, "an empty filter set filters nothing");
  expectEqual(plain.includes("company_id="), false, "not even by company");
  expectEqual(plain.includes("created_at="), false, "and not by day");

  const filtered = auditQueryOf(
    {
      filters: {
        action: "gateway.key_",
        actorUserId: SUPER_ADMIN_ID,
        entityType: "gateway",
        entityId: ENTITY_ID,
        companyId: COMPANY_ID,
        platformOnly: false,
        fromDay: "2026-11-01",
        toDay: "2026-11-02",
      },
      offset: 100,
      problems: [],
    },
    51,
  );

  expect(filtered.includes("action=like.gateway.key_*"), "an action family is a prefix match");
  expect(filtered.includes(`actor_user_id=eq.${SUPER_ADMIN_ID}`), "an actor is an equality");
  expect(filtered.includes("entity_type=eq.gateway"), "so is an entity type");
  expect(filtered.includes(`entity_id=eq.${ENTITY_ID}`), "and an entity");
  expect(filtered.includes(`company_id=eq.${COMPANY_ID}`), "and a company");
  expect(filtered.includes("created_at=gte.2026-11-01T00:00:00.000Z"), "the range starts at midnight");
  expect(filtered.includes("created_at=lt.2026-11-03T00:00:00.000Z"), "and ends past the last day named");
  expect(filtered.includes("offset=100"), "and the window it was asked for");

  const platform = auditQueryOf(
    { filters: { ...EMPTY_AUDIT_FILTERS, platformOnly: true }, offset: 0, problems: [] },
    51,
  );

  expect(platform.includes("company_id=is.null"), "the platform's chain is the rows with no company");
  expectEqual(platform.includes("company_id=eq."), false, "and is never an equality with the zero uuid");
}

/** ---- The page, over the store. */
function pageOf(result: AuditLogPage): readonly string[] {
  return result.entries.map((entry) => entry.action);
}

async function checkListing(): Promise<void> {
  const rows = Array.from({ length: 60 }, (_, index) =>
    rowOf(index, { sequence: index + 1, createdAt: new Date(NOW - index * 1_000).toISOString() }),
  );
  const database = createDatabase(rows);
  const dependencies = createDependencies(database);
  const first = await listAuditEntries(
    { actor: superAdmin, query: parseAuditQuery({}) },
    dependencies,
  );

  expectEqual(first.entries.length, AUDIT_LOG_PAGE_SIZE, "a page carries fifty rows");
  expectEqual(first.offset, 0, "from the top");
  expectEqual(first.pageSize, AUDIT_LOG_PAGE_SIZE, "and says how big it is");
  expectEqual(first.nextOffset, 50, "there is a next page, and it is named");
  expectEqual(first.previousOffset, null, "there is no page before the first");
  expectEqual(first.entries[0]?.sequence, 1, "the newest row is first");
  expectEqual(first.readAtEpochMs, NOW, "and the page says when it was read");
  expectEqual(first.platformChainId, PLATFORM_CHAIN_ID, "the platform's chain is named");
  expectEqual(first.problems.length, 0, "with nothing refused");
  expectEqual(
    database.queries[0]?.endsWith("limit=51&offset=0"),
    true,
    "the one query asks for one row more than it shows",
  );

  const second = await listAuditEntries(
    { actor: ceo, query: parseAuditQuery({ offset: "50" }) },
    dependencies,
  );

  expectEqual(second.entries.length, 10, "the last page carries what is left");
  expectEqual(second.offset, 50, "at the offset asked for");
  expectEqual(second.nextOffset, null, "and there is nothing after it");
  expectEqual(second.previousOffset, 0, "while the page before it is named");

  const third = await listAuditEntries(
    { actor: desk, query: parseAuditQuery({ offset: "5" }) },
    dependencies,
  );

  expectEqual(third.entries.length, 50, "a page in the middle is full");
  expectEqual(third.previousOffset, 0, "and can page backwards");
  expectEqual(third.nextOffset, 55, "and forwards");

  const last = await listAuditEntries(
    { actor: superAdmin, query: parseAuditQuery({ offset: String(AUDIT_LOG_MAXIMUM_OFFSET) }) },
    dependencies,
  );

  expectEqual(last.entries.length, 0, "the furthest offset reads past the end when there is nothing there");
  expectEqual(last.nextOffset, null, "and offers no next page");

  const exact = createDatabase(
    Array.from({ length: AUDIT_LOG_PAGE_SIZE }, (_, index) => rowOf(index, { sequence: index + 1 })),
  );
  const exactPage = await listAuditEntries(
    { actor: superAdmin, query: parseAuditQuery({}) },
    createDependencies(exact),
  );

  expectEqual(exactPage.entries.length, 50, "fifty rows are one full page");
  expectEqual(exactPage.nextOffset, null, "and an exact page does not promise another");

  for (const [name, actor] of refusedActors) {
    const refused = createDatabase(rows);
    const code = await failureOf(() =>
      listAuditEntries({ actor, query: parseAuditQuery({}) }, createDependencies(refused)),
    );

    expectEqual(code, "PERMISSION_DENIED", `${name} is refused the page`);
    expectEqual(refused.queries.length, 0, `and ${name} causes no query at all`);
  }
}

async function checkFiltersInAction(): Promise<void> {
  const rows = [
    rowOf(1, { sequence: 1, action: "session.started", createdAt: "2026-11-01T10:00:00.000Z" }),
    rowOf(2, {
      sequence: 2,
      action: "gateway.key_rotated",
      createdAt: "2026-11-02T10:00:00.000Z",
      companyId: COMPANY_ID,
      entityType: "gateway",
    }),
    rowOf(3, {
      sequence: 3,
      action: "gateway.key_added",
      createdAt: "2026-10-30T10:00:00.000Z",
      companyId: OTHER_COMPANY_ID,
      entityType: "gateway",
    }),
  ];
  const database = createDatabase(rows);
  const dependencies = createDependencies(database);

  const byAction = await listAuditEntries(
    { actor: superAdmin, query: parseAuditQuery({ action: "gateway." }) },
    dependencies,
  );

  expectDeepEqual(
    pageOf(byAction),
    ["gateway.key_rotated", "gateway.key_added"],
    "an action family keeps the family and nothing else",
  );
  expectEqual(
    database.queries[0]?.includes("action=like.gateway.*"),
    true,
    "and asks the database for a prefix rather than filtering in memory",
  );

  const byPrefix = await listAuditEntries(
    { actor: superAdmin, query: parseAuditQuery({ action: "gateway.key_a" }) },
    dependencies,
  );

  expectDeepEqual(pageOf(byPrefix), ["gateway.key_added"], "a longer prefix narrows to one action");

  const byCompany = await listAuditEntries(
    { actor: superAdmin, query: parseAuditQuery({ company: COMPANY_ID }) },
    dependencies,
  );

  expectDeepEqual(pageOf(byCompany), ["gateway.key_rotated"], "a company keeps its own chain");
  expectEqual(byCompany.chains.length, 1, "and the page names one chain");
  expectEqual(byCompany.chains[0]?.companyId, COMPANY_ID, "which is that company's");
  expectEqual(byCompany.chains[0]?.chainId, COMPANY_CHAIN_ID, "with the chain the row carries");

  const byPlatform = await listAuditEntries(
    { actor: superAdmin, query: parseAuditQuery({ company: AUDIT_PLATFORM_COMPANY_PARAMETER }) },
    dependencies,
  );

  expectDeepEqual(pageOf(byPlatform), ["session.started"], "the platform's chain is the rows with no company");
  expectEqual(byPlatform.chains[0]?.companyId, null, "and the page names it as the platform's own");

  const byDay = await listAuditEntries(
    { actor: superAdmin, query: parseAuditQuery({ from: "2026-11-02", to: "2026-11-02" }) },
    dependencies,
  );

  expectDeepEqual(pageOf(byDay), ["gateway.key_rotated"], "a one day range reads that day and its end");

  const byActor = await listAuditEntries(
    { actor: superAdmin, query: parseAuditQuery({ actor: SUPER_ADMIN_ID }) },
    dependencies,
  );

  expectEqual(byActor.entries.length, 3, "the actor of every row here is the same account");

  const nobody = await listAuditEntries(
    { actor: superAdmin, query: parseAuditQuery({ actor: CEO_ID }) },
    dependencies,
  );

  expectEqual(nobody.entries.length, 0, "an actor who did nothing reads nothing");

  const byEntity = await listAuditEntries(
    { actor: superAdmin, query: parseAuditQuery({ entityType: "gateway", entityId: ENTITY_ID }) },
    dependencies,
  );

  expectEqual(byEntity.entries.length, 2, "an entity type and an entity together keep the gateway rows");

  const byWrongId = await listAuditEntries(
    { actor: superAdmin, query: parseAuditQuery({ entityId: COMPANY_ID }) },
    dependencies,
  );

  expectEqual(byWrongId.entries.length, 0, "an entity identifier nothing recorded reads nothing");

  const other = await listAuditEntries(
    { actor: superAdmin, query: parseAuditQuery({ entityType: "payout" }) },
    dependencies,
  );

  expectEqual(other.entries.length, 0, "and a type nothing recorded reads nothing");
}

async function checkRowProjection(): Promise<void> {
  const longPayload = { body: "x".repeat(4_000) };
  const rows = [
    rowOf(1, {
      sequence: 1,
      action: "session.revoked",
      payload: longPayload,
      userAgent: "M".repeat(500),
      hash: "b".repeat(64),
      createdAt: NOW_ISO,
    }),
    rowOf(2, {
      sequence: 2,
      companyId: COMPANY_ID,
      entityType: null,
      entityId: null,
      actorUserId: null,
      createdAt: new Date(NOW - 1_000).toISOString(),
    }),
  ];
  const page = await listAuditEntries(
    { actor: superAdmin, query: parseAuditQuery({}) },
    createDependencies(createDatabase(rows)),
  );
  const first = page.entries[0];
  const second = page.entries[1];

  expectEqual(first?.actionFamily, "session", "the family of an action is its first segment");
  expectEqual(first?.payloadTruncated, true, "a payload past the ceiling is marked as cut");
  expectEqual(
    first?.payloadPreview.length,
    AUDIT_LOG_PAYLOAD_PREVIEW_MAXIMUM,
    "and is printed to the ceiling and no further",
  );
  expectEqual(
    first?.userAgent?.length,
    AUDIT_LOG_USER_AGENT_PREVIEW_MAXIMUM,
    "a user agent is cut too",
  );
  expectEqual(first?.hashPreview, "b".repeat(AUDIT_LOG_HASH_PREVIEW_LENGTH), "a hash is printed short");
  expectEqual(first?.prevHashPreview.length, AUDIT_LOG_HASH_PREVIEW_LENGTH, "and its predecessor as well");
  expectEqual(first?.signingKeyId, "ed25519-platform-1", "the signing key is named");
  expectEqual(first?.createdAtEpochMs, Date.parse(NOW_ISO), "the instant is read from the row");
  expectEqual(first?.createdAtIso, NOW_ISO, "and the original text is kept");

  const small = page.entries.length > 1 ? second : null;

  expect(small !== null, "the second row is on the page");
  expectEqual(small?.actionFamily, "session", "and an action reads its family the same way");
  expectEqual(small?.payloadTruncated, false, "a small payload is printed whole");
  expectEqual(small?.actorUserId, null, "an unattributed row keeps its empty actor");
  expectEqual(small?.entityType, null, "and its empty entity");
  expectEqual(small?.companyId, COMPANY_ID, "while its company is read");
  expectEqual(page.chains.length, 2, "the page names both chains it read from");

  const broken = createDatabase([rowOf(1, { createdAt: "not a date" })]);
  const code = await failureOf(() =>
    listAuditEntries({ actor: superAdmin, query: parseAuditQuery({}) }, createDependencies(broken)),
  );

  expectEqual(code, "INTERNAL_ERROR", "a row with no readable instant is a defect, not a blank cell");
}

/** ---- The chain check. */
function answerOf(overrides: Partial<Record<string, unknown>> = {}): unknown {
  return [
    {
      chain_id: PLATFORM_CHAIN_ID,
      checked_rows: 12,
      is_valid: true,
      first_broken_sequence: null,
      broken_reason: null,
      head_sequence: 12,
      head_hash: "c".repeat(64),
      ...overrides,
    },
  ];
}

async function checkVerification(): Promise<void> {
  const database = createDatabase([]);
  const dependencies = createDependencies(database);

  database.verifyAnswer = answerOf();

  const held = await verifyAuditChain({ actor: superAdmin, chainId: PLATFORM_CHAIN_ID }, dependencies);

  expectEqual(held.chainId, PLATFORM_CHAIN_ID, "the check reports the chain it read");
  expectEqual(held.checkedRows, 12, "how many rows it walked");
  expectEqual(held.isValid, true, "and that they hold");
  expectEqual(held.headSequence, 12, "the head it ends at");
  expectEqual(held.headHash, "c".repeat(64), "and that row's hash");
  expectEqual(held.firstBrokenSequence, null, "with no break to name");
  expectEqual(held.brokenReason, null, "and no reason");
  expectEqual(held.checkedAtEpochMs, NOW, "the instant of the press is the page's clock");
  expectDeepEqual(
    database.calls[0],
    { name: "audit_verify_chain", arguments: { p_chain: PLATFORM_CHAIN_ID, p_from_sequence: 1 } },
    "the function is asked with the chain and its first row, which is its whole range",
  );

  database.verifyAnswer = answerOf({
    checked_rows: "12",
    head_sequence: "12",
    is_valid: false,
    first_broken_sequence: "7",
    broken_reason: "hash mismatch",
  });

  const broken = await verifyAuditChain({ actor: ceo, chainId: PLATFORM_CHAIN_ID }, dependencies);

  expectEqual(broken.checkedRows, 12, "a bigint answered as text is still a number");
  expectEqual(broken.isValid, false, "a chain that does not hold says so");
  expectEqual(broken.firstBrokenSequence, 7, "names the first break");
  expectEqual(broken.brokenReason, "hash mismatch", "and the function's reason for it");

  const upper = await verifyAuditChain(
    { actor: desk, chainId: PLATFORM_CHAIN_ID.toUpperCase() },
    dependencies,
  );

  expectEqual(upper.chainId, PLATFORM_CHAIN_ID, "a chain named in capitals is read as its identifier");
  expectEqual(
    database.calls[database.calls.length - 1]?.arguments["p_chain"],
    PLATFORM_CHAIN_ID,
    "and is asked for in lower case",
  );

  const callsBefore = database.calls.length;
  const notAChain = await failureOf(() =>
    verifyAuditChain({ actor: superAdmin, chainId: "platform" }, dependencies),
  );

  expectEqual(notAChain, "RESOURCE_NOT_FOUND", "a chain that is not an identifier is not here");
  expectEqual(database.calls.length, callsBefore, "and the function is never asked");

  database.verifyAnswer = [];

  const empty = await failureOf(() =>
    verifyAuditChain({ actor: superAdmin, chainId: PLATFORM_CHAIN_ID }, dependencies),
  );

  expectEqual(empty, "DEPENDENCY_FAILED", "an answer with no row is an outage, not a chain that holds");

  database.verifyAnswer = answerOf({ is_valid: "yes" });

  const wrong = await failureOf(() =>
    verifyAuditChain({ actor: superAdmin, chainId: PLATFORM_CHAIN_ID }, dependencies),
  );

  expectEqual(wrong, "DEPENDENCY_FAILED", "and an answer of the wrong shape is an outage too");

  for (const [name, actor] of refusedActors) {
    const refused = createDatabase([]);
    const code = await failureOf(() =>
      verifyAuditChain({ actor, chainId: PLATFORM_CHAIN_ID }, createDependencies(refused)),
    );

    expectEqual(code, "PERMISSION_DENIED", `${name} cannot run the check`);
    expectEqual(refused.calls.length, 0, `and ${name} causes no call to the function`);
  }

  const verifiedEverywhere = createDatabase([]);
  let page: AuditLogPage | null = null;

  verifiedEverywhere.verifyAnswer = answerOf();

  page = await listAuditEntries(
    { actor: superAdmin, query: parseAuditQuery({}) },
    createDependencies(verifiedEverywhere),
  );

  const verification: AuditChainVerification = await verifyAuditChain(
    { actor: superAdmin, chainId: PLATFORM_CHAIN_ID },
    createDependencies(verifiedEverywhere),
  );

  expectEqual(page.entries.length, 0, "an empty page still renders");
  expectEqual(verification.checkedRows, 12, "and a chain with rows still verifies");
}

/** ---- The sources: the screen, the form, the catalog, the migration. */
async function collectSources(): Promise<Readonly<Record<string, string>>> {
  return {
    "lib/audit-log/registry.ts": await readRepositoryFile("lib/audit-log/registry.ts"),
    "lib/audit-log/service.ts": await readRepositoryFile("lib/audit-log/service.ts"),
    "lib/audit-log/runtime.ts": await readRepositoryFile("lib/audit-log/runtime.ts"),
    "app/(admin)/audit-log/page.tsx": await readRepositoryFile("app/(admin)/audit-log/page.tsx"),
    "app/(admin)/audit-log/audit-filter-form.tsx": await readRepositoryFile(
      "app/(admin)/audit-log/audit-filter-form.tsx",
    ),
    "app/(admin)/audit-log/audit-log-table.tsx": await readRepositoryFile(
      "app/(admin)/audit-log/audit-log-table.tsx",
    ),
    "components/office/navigation.ts": await readRepositoryFile("components/office/navigation.ts"),
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
  }

  const service = sources["lib/audit-log/service.ts"] ?? "";
  const registry = sources["lib/audit-log/registry.ts"] ?? "";
  const page = sources["app/(admin)/audit-log/page.tsx"] ?? "";
  const form = sources["app/(admin)/audit-log/audit-filter-form.tsx"] ?? "";
  const navigation = sources["components/office/navigation.ts"] ?? "";

  expectEqual(service.includes(".insert("), false, "the service inserts nothing");
  expectEqual(service.includes("insertReturning("), false, "and returns nothing it wrote");
  expectEqual(service.includes(".update("), false, "and updates nothing");
  expect(service.includes("audit_verify_chain"), "the check is the function of 0075");
  expectEqual(/hash\s*=\s*/u.test(service), false, "and no hash is computed here");
  expect(service.includes("requireAnyRole"), "every entry point asks the role list first");
  expectEqual(
    service.split("requireAnyRole(").length - 1,
    2,
    "both entry points ask it, and only them",
  );
  expect(registry.includes("AUDIT_LOG_MAXIMUM_OFFSET"), "the offset window is named once");
  expect(page.includes("getMessage("), "the page words itself from the catalog");
  expect(page.includes("parseAuditQuery("), "and reads its filters through the registry");
  expect(page.includes("verifyAuditChain("), "and runs the check the service owns");
  expect(page.includes("hrefOf("), "and links with one address builder");
  expect(form.includes('method="get"'), "the filter form is a GET form: it reads and nothing else");
  expect(form.includes('name="action"'), "it carries the action field");
  expect(form.includes('name="company"'), "and the company field");
  expectEqual(
    form.includes('type="hidden"'),
    false,
    "and no hidden field, because a new question starts at the newest end",
  );
  expect(
    navigation.includes('key: "auditLog"'),
    "the sidebar carries the audit log entry",
  );
  expect(navigation.includes('href: "/audit-log"'), "at the address the screen is served at");
  expect(
    navigation.includes("AUDIT_LOG_SCREEN_ROLES"),
    "with the role list the service enforces, imported rather than restated",
  );
}

/**
 * Every sentence the screen can print is in the catalog, and every catalog sentence is printed.
 *
 * The two directions matter differently: a key the code names and the catalog lacks throws at render
 * (it is a defect, not a blank label), while a key the catalog holds and no code prints is copy nobody
 * reads - the same kind of drift from the other side.
 */
async function checkCatalogCoverage(): Promise<void> {
  const catalogKeys = new Set(Object.keys(en.officeAudit));
  const sources = await collectSources();
  const used = new Set<string>();
  const pattern = /officeAudit\.([a-zA-Z0-9]+)/gu;

  for (const source of Object.values(sources)) {
    for (const match of source.matchAll(pattern)) {
      const key = match[1];

      if (key !== undefined) {
        used.add(key);
      }
    }
  }

  for (const key of used) {
    expect(catalogKeys.has(key), `officeAudit.${key} is in the catalog`);
  }

  for (const key of catalogKeys) {
    expect(used.has(key), `officeAudit.${key} is printed somewhere in the screen`);
  }

  const templates = en.officeAudit as Readonly<Record<string, string>>;

  for (const key of used) {
    if (!catalogKeys.has(key)) {
      continue;
    }

    const template = templates[key];
    const path = `officeAudit.${key}` as MessagePath;

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

  expect(
    getMessage("officeAudit.title") === "Audit log",
    "the screen names itself in words",
  );
  expect(
    getMessage("officeAudit.eyebrow") === "Platform office",
    "and names itself as the platform side",
  );
  expect(
    getMessage("office.sectionAuditLog").length > 0,
    "the sidebar label is in the catalog",
  );
  expect(
    getMessage("office.sectionAuditLogDescription").length > 0,
    "and so is its description",
  );
}

/** The migration is the two indexes, additive, with a rollback beside it. */
async function checkMigration(): Promise<void> {
  const files = await readdir(new URL("migrations/", repositoryRoot));
  const numbered = files.filter((name) => /^[0-9]{4}_.+\.sql$/u.test(name));
  const thisOne = numbered.filter((name) => name.startsWith("0100_"));

  expectEqual(thisOne.length, 2, "the migration and its rollback are the two files numbered 0100");
  expect(
    thisOne.includes("0100_audit_log_range_indexes.sql"),
    "the migration is the range indexes",
  );
  expect(
    thisOne.includes("0100_audit_log_range_indexes.down.sql"),
    "and the rollback is beside it",
  );

  const up = await readRepositoryFile("migrations/0100_audit_log_range_indexes.sql");
  const down = await readRepositoryFile("migrations/0100_audit_log_range_indexes.down.sql");

  expectEqual(up.split("\n")[0], "-- path: migrations/0100_audit_log_range_indexes.sql", "the migration states its path");
  expectEqual(down.split("\n")[0], "-- path: migrations/0100_audit_log_range_indexes.down.sql", "and so does the rollback");
  expect(up.includes("create index audit_logs_created_idx"), "the range index is created");
  expect(up.includes("audit_logs_action_prefix_idx"), "and the prefix index");
  expect(up.includes("text_pattern_ops"), "with the operator class a prefix needs");
  expectEqual(up.includes("create table"), false, "no table is created");
  expectEqual(up.includes("create policy"), false, "and no policy is written");
  expectEqual(/update\s+audit_logs/iu.test(up), false, "no row is touched");
  expect(
    /drop index\s+(if exists\s+)?public\.audit_logs_created_idx/u.test(down),
    "the rollback drops what the migration made",
  );
  expect(down.includes("audit_logs_created_idx"), "the range index");
  expect(down.includes("audit_logs_action_prefix_idx"), "and the prefix index");
  expectEqual(down.includes("audit_logs_action_idx"), false, "while 0013's own indexes stay");
}

async function main(): Promise<void> {
  checkConstants();
  checkProblemCopy();
  checkParsing();
  checkDays();
  checkQueryString();
  checkQuery();
  await checkListing();
  await checkFiltersInAction();
  await checkRowProjection();
  await checkVerification();
  await checkSources();
  await checkCatalogCoverage();
  await checkMigration();

  if (failures.length > 0) {
    process.stderr.write(`audit log gate failed with ${failures.length} problem(s):\n`);

    for (const failure of failures) {
      process.stderr.write(`  - ${failure}\n`);
    }

    process.exitCode = 1;

    return;
  }

  process.stdout.write(
    `audit log gate passed: ${checks} checks, ${AUDIT_LOG_READ_ROLES.length} read roles, ` +
      `${AUDIT_LOG_PAGE_SIZE} rows a page\n`,
  );
}

await main();
