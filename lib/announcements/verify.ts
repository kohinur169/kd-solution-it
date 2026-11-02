// path: lib/announcements/verify.ts
import { readFile } from "node:fs/promises";
import process from "node:process";
import type { z } from "zod";
import { AppError } from "../errors/app-error.ts";
import type { AuditEntry, AuditTrail } from "../auth/audit.ts";
import { isSensitivePath } from "../auth/request-proof.ts";
import { REAUTHENTICATION_REQUIRED_RULE, STEP_UP_WINDOW_MS } from "../auth/step-up.ts";
import { PLATFORM_ROLES, type PlatformRole, type RequestActor } from "../auth/types.ts";
import { getMessage, type MessagePath } from "../i18n/messages.ts";
import { en } from "../i18n/strings/en.ts";
import { CSRF_PROTECTED_PATHS } from "../security/csrf.ts";
import {
  ANNOUNCEMENT_AUDIENCES,
  ANNOUNCEMENT_AUDIT_ACTIONS,
  ANNOUNCEMENT_BODY_MAXIMUM_LENGTH,
  ANNOUNCEMENT_EXPIRY_MAXIMUM_DAYS,
  ANNOUNCEMENT_LEVELS,
  ANNOUNCEMENT_LIST_LIMIT,
  ANNOUNCEMENT_MANAGE_ROLES,
  ANNOUNCEMENT_OFFICE_AUDIENCE_ROLES,
  ANNOUNCEMENT_POPUP_LIMIT,
  ANNOUNCEMENT_READ_ROLES,
  ANNOUNCEMENT_SCREEN_ROLES,
  ANNOUNCEMENT_TITLE_MAXIMUM_LENGTH,
  announcementAudienceHintKey,
  announcementAudienceLabelKey,
  announcementBodyProblemOf,
  announcementExpiryProblemOf,
  announcementLevelHintKey,
  announcementLevelLabelKey,
  announcementStateLabelKey,
  announcementStateOf,
  announcementTitleProblemOf,
  calendarDayOf,
  endOfDayEpochMs,
  isAnnouncementAudience,
  isAnnouncementLevel,
  isAnnouncementVisibleTo,
  type AnnouncementAudience,
  type AnnouncementState,
} from "./registry.ts";
import {
  dismissAnnouncement,
  listActiveAnnouncements,
  listAnnouncements,
  publishAnnouncement,
  saveAnnouncement,
  withdrawAnnouncement,
  type AnnouncementDependencies,
  type AnnouncementStore,
} from "./service.ts";

/**
 * The announcements gate: run with `node lib/announcements/verify.ts`.
 *
 * Section 24 is three sentences, and every one of them is a property no screen can show:
 *
 *   1. **The super administrator writes, three roles read.** The composer refuses every other role
 *      before the first read, and refuses a stale second factor with the rule STEP 053 names.
 *   2. **A draft is invisible and a published row is fixed.** Publishing sets the instant once, the
 *      popup query reads only published rows that have not expired, and an edit after publication is
 *      a conflict rather than a silent change to words people already acted on.
 *   3. **A dismissal is one row per person, and it is forever.** The unique index is the rule: a
 *      second dismissal is not an error, and the announcement is gone from that person's popups for
 *      good.
 *
 * The service runs over an in-memory PostgREST with the four methods `RestClient` exposes - including
 * the unique index of `0008`, so a duplicate dismissal is a real conflict here and not a mock - and
 * the screens, the route and the migrations are read as source, because a `.tsx` file cannot be
 * imported by plain Node and a migration is a document until it is applied.
 *
 * ## What it cannot prove
 *
 * That PostgREST is reachable, that `0073` was applied to a particular project, and that a person can
 * read a banner at both widths - those are deployment and browser facts, and the handoff lists the
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
    failures.push(`${description} (expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)})`);
  }
}

async function readRepositoryFile(repositoryPath: string): Promise<string> {
  return readFile(new URL(repositoryPath, repositoryRoot), "utf8");
}

/** The instant every scenario runs at, so a publish and an expiry are exact. */
const NOW = 1_800_000_000_000;
const NOW_ISO = new Date(NOW).toISOString();
const DAY = 86_400_000;

const SUPER_ADMIN_ID = "018f2b8a-1111-4c2d-9c3e-000000000001";
const CEO_ID = "018f2b8a-1111-4c2d-9c3e-000000000002";
const SUPPORT_ID = "018f2b8a-1111-4c2d-9c3e-000000000003";
const OWNER_ID = "018f2b8a-1111-4c2d-9c3e-000000000004";
const DESK_ID = "018f2b8a-1111-4c2d-9c3e-000000000005";
const COMPANY_ID = "018f2b8a-9999-4c2d-9c3e-000000000001";
const OTHER_COMPANY_ID = "018f2b8a-9999-4c2d-9c3e-000000000002";

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
const support = actorOf(["support"], { userId: SUPPORT_ID });
const owner = actorOf(["owner"], { userId: OWNER_ID, companyId: COMPANY_ID });
const desk = actorOf(["compliance_kyc"], { userId: DESK_ID });
const finance = actorOf(["finance_ops"], { userId: OWNER_ID });
const staleSuperAdmin = actorOf(["super_admin"], {
  mfaVerifiedAtEpochMs: NOW - STEP_UP_WINDOW_MS - 1,
  reauthenticatedAtEpochMs: NOW - STEP_UP_WINDOW_MS - 1,
});

interface RecordedAudit extends AuditTrail {
  readonly entries: AuditEntry[];
}

function createAudit(): RecordedAudit {
  const entries: AuditEntry[] = [];

  return {
    entries,
    append(entry: AuditEntry): Promise<void> {
      entries.push(entry);

      return Promise.resolve();
    },
  };
}

type Row = Record<string, unknown>;

interface Filter {
  readonly column: string;
  readonly operator: "eq" | "in" | "isNull" | "isNotNull";
  readonly values: readonly string[];
}

interface Query {
  readonly filters: readonly Filter[];
  readonly limit: number;
  readonly order: { readonly column: string; readonly descending: boolean } | null;
}

/** The operators this module's queries use, and nothing else. */
function parseQuery(query: string): Query {
  const filters: Filter[] = [];
  let limit = 1_000;
  let order: Query["order"] = null;

  for (const part of query.split("&")) {
    if (part.length === 0 || part.startsWith("select=") || part.startsWith("offset=")) {
      continue;
    }

    if (part.startsWith("order=")) {
      const [column = "", direction = "asc"] = part.slice("order=".length).split(".");
      order = { column, descending: direction === "desc" };

      continue;
    }

    if (part.startsWith("limit=")) {
      const parsed = Number.parseInt(part.slice("limit=".length), 10);

      if (Number.isFinite(parsed) && parsed > 0) {
        limit = parsed;
      }

      continue;
    }

    const separator = part.indexOf("=");
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
      const list = expression.slice(4, -1);

      filters.push({
        column,
        operator: "in",
        values: list.split(",").map((value) => decodeURIComponent(value.trim())),
      });
      continue;
    }

    throw new Error(`the gate's store does not speak this operator: ${part}`);
  }

  return { filters, limit, order };
}

function matches(row: Row, filters: readonly Filter[]): boolean {
  return filters.every((filter) => {
    const value = row[filter.column];
    const isNull = value === null || value === undefined;

    if (filter.operator === "isNull") {
      return isNull;
    }

    if (filter.operator === "isNotNull") {
      return !isNull;
    }

    if (filter.operator === "eq") {
      return String(value ?? "") === filter.values[0];
    }

    return filter.values.some((candidate) => String(value ?? "") === candidate);
  });
}

interface FakeDatabase {
  readonly tables: Record<string, Row[]>;
  readonly queries: string[];
  readonly writes: string[];
  /** The column names of every update payload, so a scenario can prove `version` is never sent. */
  readonly updateColumns: string[][];
  readonly audits: RecordedAudit;
  nextId: number;
  /** Called before every update, so a scenario can stage a write that lands in between two of ours. */
  beforeUpdate?: (table: string, query: string) => void;
}

function createDatabase(): FakeDatabase {
  return {
    tables: { announcements: [], announcement_dismissals: [] },
    queries: [],
    writes: [],
    updateColumns: [],
    audits: createAudit(),
    nextId: 1,
  };
}

function rowsOf(database: FakeDatabase, table: string): Row[] {
  return database.tables[table] ?? [];
}

/** A row as the database would hold it after an insert: identifiers and the metadata columns. */
function stampInserted(database: FakeDatabase, row: Row): Row {
  const id = `018f2b8a-3333-4c2d-9c3e-${String(database.nextId).padStart(12, "0")}`;

  database.nextId += 1;

  return {
    company_id: null,
    created_at: NOW_ISO,
    updated_at: NOW_ISO,
    deleted_at: null,
    version: 1,
    published_at: null,
    expires_at: null,
    created_by: null,
    dismissed_at: null,
    ...row,
    id: typeof row["id"] === "string" ? row["id"] : id,
  };
}

/** The store: PostgREST's four methods, the version bump, and `0008`'s unique index. */
function createStore(database: FakeDatabase): AnnouncementStore {
  return {
    select<TRow>(table: string, query: string, schema: z.ZodType<TRow>): Promise<readonly TRow[]> {
      database.queries.push(`${table}?${query}`);

      const { filters, limit, order } = parseQuery(query);
      const matched = rowsOf(database, table).filter((row) => matches(row, filters));

      if (order !== null) {
        const column = order.column;
        const direction = order.descending ? -1 : 1;

        matched.sort((left, right) =>
          String(left[column] ?? "").localeCompare(String(right[column] ?? "")) * direction,
        );
      }

      return Promise.resolve(matched.slice(0, limit).map((row) => schema.parse(row)));
    },
    insert(table: string, rows: readonly Row[]): Promise<void> {
      database.writes.push(`insert ${table} ${String(rows.length)}`);

      for (const row of rows) {
        // `announcement_dismissals_key` is a unique index on the pair, so a second dismissal is the
        // same conflict PostgREST reports as `23505`.
        if (table === "announcement_dismissals") {
          const duplicate = rowsOf(database, table).some(
            (existing) =>
              String(existing["announcement_id"] ?? "") === String(row["announcement_id"] ?? "") &&
              String(existing["user_id"] ?? "") === String(row["user_id"] ?? ""),
          );

          if (duplicate) {
            throw new AppError("CONFLICT");
          }
        }

        rowsOf(database, table).push(stampInserted(database, row));
      }

      return Promise.resolve();
    },
    insertReturning<TRow>(
      table: string,
      rows: readonly Row[],
      schema: z.ZodType<TRow>,
    ): Promise<readonly TRow[]> {
      database.writes.push(`insertReturning ${table} ${String(rows.length)}`);

      const inserted = rows.map((row) => stampInserted(database, row));

      rowsOf(database, table).push(...inserted);

      return Promise.resolve(inserted.map((row) => schema.parse(row)));
    },
    update(table: string, query: string, values: Row): Promise<void> {
      database.writes.push(`update ${table}?${query}`);
      database.updateColumns.push(Object.keys(values));
      database.beforeUpdate?.(table, query);

      const { filters } = parseQuery(query);

      for (const row of rowsOf(database, table)) {
        if (!matches(row, filters)) {
          continue;
        }

        for (const [column, value] of Object.entries(values)) {
          row[column] = value;
        }

        row["version"] = Number(row["version"] ?? 1) + 1;
        row["updated_at"] = NOW_ISO;
      }

      return Promise.resolve();
    },
  };
}

function createDependencies(database: FakeDatabase): AnnouncementDependencies {
  return {
    store: createStore(database),
    audit: database.audits,
    now: (): number => NOW,
  };
}

/** The failure a call answered with, as `CODE|rule`, or `no-throw`. */
async function failureOf(call: () => Promise<unknown>): Promise<string> {
  try {
    await call();

    return "no-throw";
  } catch (error) {
    const code = (error as { readonly code?: unknown }).code;
    const details = (error as { readonly details?: unknown }).details;
    const rule =
      Array.isArray(details) && details.length > 0
        ? (details[0] as { readonly rule?: unknown }).rule
        : undefined;

    return `${typeof code === "string" ? code : "unknown"}|${typeof rule === "string" ? rule : ""}`;
  }
}

/** One `announcements` row, as `0007` defines it. */
function announcementRow(overrides: Row = {}): Row {
  return {
    id: announcementIdOf(announcementRow.counter),
    company_id: null,
    title: "Scheduled maintenance this Sunday",
    body: "Card payments pause between 02:00 and 03:00 UTC while the processor rotates keys.",
    level: "warning",
    audience: "all",
    published_at: null,
    expires_at: null,
    created_by: SUPER_ADMIN_ID,
    deleted_at: null,
    created_at: NOW_ISO,
    updated_at: NOW_ISO,
    version: 1,
    ...overrides,
  };
}

announcementRow.counter = 1;

function announcementIdOf(index: number): string {
  return `018f2b8a-6666-4c2d-9c3e-${String(index).padStart(12, "0")}`;
}

/** A day `offset` days from today, as a date input would send it. */
function dayFromToday(offset: number): string {
  return calendarDayOf(NOW + offset * DAY);
}

/** The draft the composer form produces. */
function draftOf(overrides: Partial<Parameters<typeof saveAnnouncement>[0]> = {}): Parameters<typeof saveAnnouncement>[0] {
  return {
    actor: superAdmin,
    announcementId: null,
    title: "  Scheduled maintenance this Sunday  ",
    body: "  Card payments pause between 02:00 and 03:00 UTC.  ",
    level: "warning",
    audience: "all",
    expiresOn: null,
    ...overrides,
  };
}

/** ---- The registry: roles, names, audiences, states and the bounds the column enforces. */
function checkRegistry(): void {
  expectEqual(ANNOUNCEMENT_MANAGE_ROLES.join(","), "super_admin", "section 24 names one writer");
  expectEqual(
    ANNOUNCEMENT_READ_ROLES.join(","),
    "ceo,support,super_admin",
    "and three readers of the composer",
  );
  expectEqual(
    ANNOUNCEMENT_SCREEN_ROLES.join(","),
    ANNOUNCEMENT_READ_ROLES.join(","),
    "the screen is the read list",
  );
  expect(
    ANNOUNCEMENT_MANAGE_ROLES.every((role) => ANNOUNCEMENT_SCREEN_ROLES.includes(role)),
    "and the writer may open it",
  );
  expectEqual(
    ANNOUNCEMENT_OFFICE_AUDIENCE_ROLES.join(","),
    "super_admin,ceo,compliance_kyc,finance_ops,support,blogger",
    "an office audience is the six platform roles minus the merchant",
  );
  expectEqual(
    ANNOUNCEMENT_OFFICE_AUDIENCE_ROLES.join(","),
    PLATFORM_ROLES.filter((role) => role !== "owner").join(","),
    "derived from the seven rather than written out again",
  );
  expect(Object.isFrozen(ANNOUNCEMENT_MANAGE_ROLES), "the writer list is frozen");
  expect(Object.isFrozen(ANNOUNCEMENT_SCREEN_ROLES), "and the read list");

  const auditPattern = /^[a-z][a-z0-9]*(\.[a-z0-9_]+)+$/u;

  for (const action of ANNOUNCEMENT_AUDIT_ACTIONS) {
    expect(auditPattern.test(action), `${action} is a valid audit name`);
    expect(action.length <= 64, `${action} fits the audit column`);
  }

  expectEqual(ANNOUNCEMENT_AUDIT_ACTIONS.length, 4, "four things this STEP records");
  expectEqual(
    new Set<string>(ANNOUNCEMENT_AUDIT_ACTIONS).size,
    ANNOUNCEMENT_AUDIT_ACTIONS.length,
    "no name is used twice",
  );
  expect(Object.isFrozen(ANNOUNCEMENT_AUDIT_ACTIONS), "the audit list is frozen");

  for (const level of ANNOUNCEMENT_LEVELS) {
    expect(getMessage(announcementLevelLabelKey(level)).length > 0, `${level} has a label`);
    expect(getMessage(announcementLevelHintKey(level)).length > 0, `${level} has a hint`);
    expect(isAnnouncementLevel(level), `${level} is a level`);
  }

  for (const audience of ANNOUNCEMENT_AUDIENCES) {
    expect(getMessage(announcementAudienceLabelKey(audience)).length > 0, `${audience} has a label`);
    expect(getMessage(announcementAudienceHintKey(audience)).length > 0, `${audience} has a hint`);
    expect(isAnnouncementAudience(audience), `${audience} is an audience`);
  }

  const states: readonly AnnouncementState[] = ["draft", "live", "ended"];

  for (const state of states) {
    expect(getMessage(announcementStateLabelKey(state)).length > 0, `${state} has a badge`);
  }

  expectEqual(isAnnouncementLevel("notice"), false, "an unknown level is refused");
  expectEqual(isAnnouncementAudience("everyone"), false, "and an unknown audience");
  expectEqual(isAnnouncementLevel(null), false, "nor is a value that is not even a string");
  expectEqual(
    new Set(ANNOUNCEMENT_LEVELS.map((level) => getMessage(announcementLevelLabelKey(level)))).size,
    ANNOUNCEMENT_LEVELS.length,
    "three levels, three names",
  );

  // ---- the state at an instant
  expectEqual(
    announcementStateOf({ publishedAtEpochMs: null, expiresAtEpochMs: null, nowEpochMs: NOW }),
    "draft",
    "no publish instant is a draft",
  );
  expectEqual(
    announcementStateOf({
      publishedAtEpochMs: NOW - DAY,
      expiresAtEpochMs: null,
      nowEpochMs: NOW,
    }),
    "live",
    "a published row with no expiry is live",
  );
  expectEqual(
    announcementStateOf({
      publishedAtEpochMs: NOW - DAY,
      expiresAtEpochMs: NOW + DAY,
      nowEpochMs: NOW,
    }),
    "live",
    "and one whose expiry is ahead",
  );
  expectEqual(
    announcementStateOf({
      publishedAtEpochMs: NOW - DAY,
      expiresAtEpochMs: NOW,
      nowEpochMs: NOW,
    }),
    "ended",
    "the instant of the expiry is the end",
  );
  expectEqual(
    announcementStateOf({ publishedAtEpochMs: null, expiresAtEpochMs: NOW - DAY, nowEpochMs: NOW }),
    "draft",
    "a draft that carries an expiry is still a draft",
  );

  // ---- who sees what
  const visible = (input: {
    audience: AnnouncementAudience;
    companyId?: string | null;
    publishedAtEpochMs?: number | null;
    expiresAtEpochMs?: number | null;
    viewer: { companyId: string | null; roles: readonly PlatformRole[] };
  }): boolean =>
    isAnnouncementVisibleTo({
      audience: input.audience,
      companyId: input.companyId ?? null,
      publishedAtEpochMs: input.publishedAtEpochMs === undefined ? NOW - DAY : input.publishedAtEpochMs,
      expiresAtEpochMs: input.expiresAtEpochMs ?? null,
      nowEpochMs: NOW,
      viewer: input.viewer,
    });

  expect(visible({ audience: "all", viewer: { companyId: null, roles: ["super_admin"] } }), "everything reaches the office");
  expect(visible({ audience: "all", viewer: { companyId: COMPANY_ID, roles: ["owner"] } }), "and reaches a merchant");
  expect(visible({ audience: "owners", viewer: { companyId: COMPANY_ID, roles: ["owner"] } }), "a merchant audience reaches a merchant");
  expectEqual(
    visible({ audience: "owners", viewer: { companyId: null, roles: ["super_admin"] } }),
    false,
    "and not an office account",
  );
  expect(visible({ audience: "office", viewer: { companyId: null, roles: ["support"] } }), "an office audience reaches the office");
  expectEqual(
    visible({ audience: "office", viewer: { companyId: COMPANY_ID, roles: ["owner"] } }),
    false,
    "and not a merchant",
  );
  expectEqual(
    visible({ audience: "all", publishedAtEpochMs: null, viewer: { companyId: null, roles: ["super_admin"] } }),
    false,
    "a draft is shown to nobody, not even the writer",
  );
  expectEqual(
    visible({
      audience: "all",
      expiresAtEpochMs: NOW - 1,
      viewer: { companyId: null, roles: ["super_admin"] },
    }),
    false,
    "and an ended banner stops for everybody",
  );
  expectEqual(
    visible({ audience: "all", companyId: OTHER_COMPANY_ID, viewer: { companyId: COMPANY_ID, roles: ["owner"] } }),
    false,
    "a row written for another company is not this one's",
  );
  expect(
    visible({ audience: "all", companyId: COMPANY_ID, viewer: { companyId: COMPANY_ID, roles: ["owner"] } }),
    "while the company it was written for does see it",
  );
  expectEqual(
    visible({ audience: "all", companyId: COMPANY_ID, viewer: { companyId: null, roles: ["super_admin"] } }),
    false,
    "and platform staff are not a company",
  );

  // ---- the bounds
  expectEqual(ANNOUNCEMENT_TITLE_MAXIMUM_LENGTH, 140, "the headline's ceiling is the column's");
  expectEqual(ANNOUNCEMENT_BODY_MAXIMUM_LENGTH, 5_000, "and so is the message's");
  expectEqual(ANNOUNCEMENT_LIST_LIMIT, 100, "one composer read is bounded");
  expectEqual(ANNOUNCEMENT_POPUP_LIMIT, 3, "and one page load shows at most three banners");
  expectEqual(ANNOUNCEMENT_EXPIRY_MAXIMUM_DAYS, 365, "an expiry is at most a year ahead");
  expectEqual(announcementTitleProblemOf("  "), "required", "an empty headline is a refusal");
  expectEqual(announcementTitleProblemOf("a".repeat(141)), "too_long", "and one over the column");
  expectEqual(announcementTitleProblemOf(" Maintenance "), null, "a filled one is fine");
  expectEqual(announcementBodyProblemOf("   "), "required", "an empty message is a refusal");
  expectEqual(announcementBodyProblemOf("a".repeat(5_001)), "too_long", "and one over five thousand");
  expectEqual(
    announcementExpiryProblemOf({ expiresAtEpochMs: null, nowEpochMs: NOW }),
    null,
    "an expiry is optional",
  );
  expectEqual(
    announcementExpiryProblemOf({ expiresAtEpochMs: NOW - 1, nowEpochMs: NOW }),
    "invalid_range",
    "a past expiry is refused",
  );
  expectEqual(
    announcementExpiryProblemOf({ expiresAtEpochMs: NOW + 366 * DAY, nowEpochMs: NOW }),
    "invalid_range",
    "and one more than a year away",
  );
  expectEqual(
    announcementExpiryProblemOf({ expiresAtEpochMs: NOW + 30 * DAY, nowEpochMs: NOW }),
    null,
    "a month ahead is fine",
  );
  expectEqual(
    announcementExpiryProblemOf({ expiresAtEpochMs: 1.5, nowEpochMs: NOW }),
    "invalid_format",
    "and a value that is not an instant",
  );

  // ---- the day an expiry names
  const lastDayOfMay = endOfDayEpochMs("2026-05-31");

  expectEqual(
    lastDayOfMay === null ? "" : new Date(lastDayOfMay).toISOString(),
    "2026-05-31T23:59:59.999Z",
    "an expiry day means the last instant of that day",
  );
  expectEqual(endOfDayEpochMs("2026-02-30"), null, "a day that does not exist has no end");
  expectEqual(endOfDayEpochMs("2026-5-1"), null, "nor does a day written short");
  expectEqual(endOfDayEpochMs(""), null, "nor an empty value");
  expectEqual(
    endOfDayEpochMs(dayFromToday(0)) === null ? "" : new Date(endOfDayEpochMs(dayFromToday(0)) ?? 0).toISOString().slice(0, 10),
    dayFromToday(0),
    "and today ends today",
  );

  // ---- the copy the two surfaces render
  const templates: Readonly<Record<string, string>> = Object.fromEntries(
    Object.entries(en.announcements as Readonly<Record<string, string>>).map(([key, value]) => [
      `announcements.${key}`,
      value,
    ]),
  );
  const required: readonly MessagePath[] = [
    "office.sectionAnnouncements",
    "office.sectionAnnouncementsDescription",
    "announcements.title",
    "announcements.description",
    "announcements.composerHeading",
    "announcements.listHeading",
    "announcements.saveSubmit",
    "announcements.publishSubmit",
    "announcements.withdrawSubmit",
    "announcements.newDraft",
    "announcements.listEmpty",
    "announcements.readOnly",
    "announcements.popupLabel",
    "announcements.popupDismiss",
    "announcements.popupDismissed",
    "announcements.forbidden",
    "announcements.titleInvalid",
    "announcements.bodyInvalid",
  ];
  const officeTemplates: Readonly<Record<string, string>> = Object.fromEntries(
    Object.entries(en.office as Readonly<Record<string, string>>).map(([key, value]) => [
      `office.${key}`,
      value,
    ]),
  );

  for (const path of required) {
    const message = templates[path] ?? officeTemplates[path] ?? "";

    expect(message.length > 0, `${path} is in the catalog`);
    expectEqual(message, message.trim(), `${path} is trimmed`);
    expectEqual(message.includes("  "), false, `${path} has no double space`);
    expectEqual((message.match(/\{/gu) ?? []).length, 0, `${path} renders whole`);
  }

  for (const path of ["announcements.counts", "announcements.popupCounter", "announcements.editingDraft"]) {
    expect(/\{[a-zA-Z][a-zA-Z0-9]*\}/u.test(templates[path] ?? ""), `${path} keeps its placeholders`);
  }
}

/** ---- The composer: three reads, one writer, and what a state allows. */
async function checkComposer(): Promise<void> {
  const database = createDatabase();

  expectEqual(
    await failureOf(() => listAnnouncements({ actor: desk }, createDependencies(database))),
    "PERMISSION_DENIED|",
    "the compliance desk may not read the composer",
  );
  expectEqual(
    await failureOf(() => listAnnouncements({ actor: finance }, createDependencies(database))),
    "PERMISSION_DENIED|",
    "nor finance",
  );
  expectEqual(
    await failureOf(() => listAnnouncements({ actor: owner }, createDependencies(database))),
    "PERMISSION_DENIED|",
    "nor a merchant",
  );

  const empty = await listAnnouncements({ actor: superAdmin }, createDependencies(database));

  expectEqual(empty.items.length, 0, "a fresh deployment has nothing written");
  expectEqual(empty.draftCount, 0, "with no drafts");
  expectEqual(empty.readAtEpochMs, NOW, "and names the instant it read at");
  expectEqual(empty.canManage, true, "the super administrator may write");
  expectEqual(
    (await listAnnouncements({ actor: ceo }, createDependencies(database))).canManage,
    false,
    "the chief executive reads without the buttons",
  );

  const created = await saveAnnouncement(draftOf(), createDependencies(database));
  const stored = rowsOf(database, "announcements")[0];

  expectEqual(created.items.length, 1, "saving a new draft lists it");
  expectEqual(stored?.["title"], "Scheduled maintenance this Sunday", "the headline is trimmed");
  expectEqual(stored?.["body"], "Card payments pause between 02:00 and 03:00 UTC.", "and so is the message");
  expectEqual(stored?.["published_at"], null, "a new announcement is a draft");
  expectEqual(stored?.["expires_at"], null, "with no expiry when none was given");
  expectEqual(stored?.["audience"], "all", "and the audience it was given");
  expectEqual(stored?.["created_by"], SUPER_ADMIN_ID, "recording who wrote it");
  expectEqual(created.draftCount, 1, "and the count says one draft");
  expectEqual(created.items[0]?.state, "draft", "the row is a draft");
  expectEqual(created.items[0]?.stateLabelKey, "announcements.stateDraft", "with its badge");
  expectEqual(created.items[0]?.levelLabelKey, "announcements.levelWarning", "and its emphasis");
  expectEqual(
    database.audits.entries.at(-1)?.action,
    "announcement.saved",
    "the draft is on the audit trail",
  );
  expectEqual(database.audits.entries.at(-1)?.payload?.["created"], true, "naming that it was created");

  const draftId = created.items[0]?.id ?? "";

  // A draft is editable; a version the caller did not read is a conflict.
  const edited = await saveAnnouncement(
    draftOf({ announcementId: draftId, title: "Maintenance moved to Monday" }),
    createDependencies(database),
  );

  expectEqual(edited.items[0]?.title, "Maintenance moved to Monday", "a draft can be rewritten");
  expectEqual(edited.items[0]?.version, 2, "and its version moves by one");
  expectEqual(
    database.audits.entries.at(-1)?.payload?.["title_changed"],
    true,
    "the entry says the headline moved",
  );
  expectEqual(
    database.audits.entries.at(-1)?.payload?.["created"],
    false,
    "and that it was not a creation",
  );

  const expiryDay = dayFromToday(10);
  const withExpiry = await saveAnnouncement(
    draftOf({ announcementId: draftId, expiresOn: expiryDay }),
    createDependencies(database),
  );

  expectEqual(
    withExpiry.items[0]?.expiresAtEpochMs,
    endOfDayEpochMs(expiryDay),
    "the day the form sent becomes the last instant of that day",
  );

  // ---- the refusals
  expectEqual(
    await failureOf(() => saveAnnouncement(draftOf({ title: "   " }), createDependencies(database))),
    "VALIDATION_FAILED|required",
    "a draft with no headline is refused",
  );
  expectEqual(
    await failureOf(() =>
      saveAnnouncement(draftOf({ title: "a".repeat(141) }), createDependencies(database)),
    ),
    "VALIDATION_FAILED|too_long",
    "and one over the column",
  );
  expectEqual(
    await failureOf(() => saveAnnouncement(draftOf({ body: "" }), createDependencies(database))),
    "VALIDATION_FAILED|required",
    "a draft with no message is refused",
  );
  expectEqual(
    await failureOf(() =>
      saveAnnouncement(draftOf({ level: "shout" }), createDependencies(database)),
    ),
    "VALIDATION_FAILED|invalid_format",
    "an unknown emphasis is refused",
  );
  expectEqual(
    await failureOf(() =>
      saveAnnouncement(draftOf({ audience: "everyone" }), createDependencies(database)),
    ),
    "VALIDATION_FAILED|invalid_format",
    "and an unknown audience",
  );
  expectEqual(
    await failureOf(() =>
      saveAnnouncement(draftOf({ expiresOn: "2026-02-30" }), createDependencies(database)),
    ),
    "VALIDATION_FAILED|invalid_date",
    "a day that does not exist is refused",
  );
  expectEqual(
    await failureOf(() =>
      saveAnnouncement(draftOf({ expiresOn: dayFromToday(-1) }), createDependencies(database)),
    ),
    "VALIDATION_FAILED|invalid_range",
    "and an expiry behind us",
  );
  expectEqual(
    await failureOf(() =>
      saveAnnouncement(draftOf({ expiresOn: dayFromToday(400) }), createDependencies(database)),
    ),
    "VALIDATION_FAILED|invalid_range",
    "and one more than a year ahead",
  );
  expectEqual(
    await failureOf(() =>
      saveAnnouncement(draftOf({ actor: ceo }), createDependencies(database)),
    ),
    "PERMISSION_DENIED|",
    "the chief executive may not write one",
  );
  expectEqual(
    await failureOf(() =>
      saveAnnouncement(draftOf({ actor: staleSuperAdmin }), createDependencies(database)),
    ),
    `PERMISSION_DENIED|${REAUTHENTICATION_REQUIRED_RULE}`,
    "and a stale second factor is asked for again",
  );
  expectEqual(
    await failureOf(() =>
      saveAnnouncement(
        draftOf({ announcementId: "018f2b8a-6666-4c2d-9c3e-999999999999" }),
        createDependencies(database),
      ),
    ),
    "RESOURCE_NOT_FOUND|",
    "a draft that is not there cannot be edited",
  );

  // ---- publishing
  const published = await publishAnnouncement(
    { actor: superAdmin, announcementId: draftId },
    createDependencies(database),
  );
  const liveRow = rowsOf(database, "announcements")[0];

  expectEqual(liveRow?.["published_at"], NOW_ISO, "publishing stamps the instant");
  expectEqual(published.items[0]?.state, "live", "the row becomes live");
  expectEqual(published.liveCount, 1, "and the count says so");
  expectEqual(published.draftCount, 0, "with no drafts left");
  expectEqual(
    database.audits.entries.at(-1)?.action,
    "announcement.published",
    "the publish is on the audit trail",
  );
  expectEqual(
    database.audits.entries.at(-1)?.payload?.["audience"],
    "all",
    "naming the audience it went to",
  );
  expectEqual(
    await failureOf(() => publishAnnouncement({ actor: superAdmin, announcementId: draftId }, createDependencies(database))),
    "CONFLICT|published",
    "publishing twice is a conflict, not a re-stamp",
  );
  expectEqual(
    await failureOf(() =>
      saveAnnouncement(draftOf({ announcementId: draftId, title: "Changed under the banner" }), createDependencies(database)),
    ),
    "CONFLICT|published",
    "and the words of a published banner cannot be changed",
  );
  expectEqual(
    await failureOf(() => publishAnnouncement({ actor: ceo, announcementId: draftId }, createDependencies(database))),
    "PERMISSION_DENIED|",
    "the chief executive may not publish",
  );

  // A draft whose expiry lapsed while it waited cannot be published.
  const lapsed = createDatabase();

  rowsOf(lapsed, "announcements").push(
    announcementRow({
      id: announcementIdOf(9),
      expires_at: new Date(NOW - DAY).toISOString(),
    }),
  );

  expectEqual(
    await failureOf(() =>
      publishAnnouncement({ actor: superAdmin, announcementId: announcementIdOf(9) }, createDependencies(lapsed)),
    ),
    "VALIDATION_FAILED|invalid_range",
    "a draft whose expiry is already behind us cannot be published",
  );

  // ---- withdrawing
  const withdrawn = await withdrawAnnouncement(
    { actor: superAdmin, announcementId: draftId },
    createDependencies(database),
  );

  expectEqual(rowsOf(database, "announcements")[0]?.["expires_at"], NOW_ISO, "withdrawing writes the expiry");
  expectEqual(withdrawn.items[0]?.state, "ended", "and the row is ended");
  expectEqual(withdrawn.endedCount, 1, "which the count says");
  expectEqual(
    database.audits.entries.at(-1)?.action,
    "announcement.withdrawn",
    "the withdrawal is on the audit trail",
  );
  expectEqual(database.audits.entries.at(-1)?.payload?.["days_live"], 0, "with how long it was live");
  expectEqual(
    await failureOf(() => withdrawAnnouncement({ actor: superAdmin, announcementId: draftId }, createDependencies(database))),
    "CONFLICT|ended",
    "an ended banner cannot be ended again",
  );
  expectEqual(
    await failureOf(() =>
      withdrawAnnouncement({ actor: superAdmin, announcementId: announcementIdOf(9) }, createDependencies(lapsed)),
    ),
    "CONFLICT|not_published",
    "and a draft was never showing, so there is nothing to stop",
  );

  // A write that loses the race is a conflict rather than a silent overwrite.
  const raced = createDatabase();

  rowsOf(raced, "announcements").push(announcementRow({ id: announcementIdOf(1) }));
  raced.beforeUpdate = (table: string): void => {
    const row = rowsOf(raced, table)[0];

    if (row !== undefined) {
      row["version"] = Number(row["version"] ?? 1) + 2;
    }
  };

  expectEqual(
    await failureOf(() =>
      publishAnnouncement({ actor: superAdmin, announcementId: announcementIdOf(1) }, createDependencies(raced)),
    ),
    "CONFLICT|stale",
    "a publish that another write overtook is a conflict",
  );

  for (const columns of database.updateColumns) {
    expect(!columns.includes("version"), "no update sends version: the trigger owns the counter");
  }
}

/** ---- The popup and the dismissal. */
function seedWorld(database: FakeDatabase): void {
  rowsOf(database, "announcements").push(
    announcementRow({
      id: announcementIdOf(1),
      title: "Cyber insurance renewed",
      level: "info",
      audience: "all",
      published_at: new Date(NOW - 3 * DAY).toISOString(),
    }),
    announcementRow({
      id: announcementIdOf(2),
      title: "PCI attestation due next month",
      level: "warning",
      audience: "office",
      published_at: new Date(NOW - 2 * DAY).toISOString(),
    }),
    announcementRow({
      id: announcementIdOf(3),
      title: "Payout batches move to Tuesday",
      level: "critical",
      audience: "owners",
      published_at: new Date(NOW - DAY).toISOString(),
    }),
    announcementRow({
      id: announcementIdOf(4),
      title: "A draft nobody has published",
      published_at: null,
    }),
    announcementRow({
      id: announcementIdOf(5),
      title: "An ended banner",
      published_at: new Date(NOW - 30 * DAY).toISOString(),
      expires_at: new Date(NOW - 5 * DAY).toISOString(),
    }),
    announcementRow({
      id: announcementIdOf(6),
      title: "Another company's notice",
      company_id: OTHER_COMPANY_ID,
      published_at: new Date(NOW - DAY).toISOString(),
    }),
  );
}

async function checkPopup(): Promise<void> {
  const database = createDatabase();

  seedWorld(database);

  const dependencies = createDependencies(database);
  const officePopups = await listActiveAnnouncements({ actor: support }, dependencies);

  expectEqual(
    officePopups.map((item) => item.id).join(","),
    [announcementIdOf(2), announcementIdOf(1)].join(","),
    "office staff see the office audience and everybody's, newest first",
  );
  expectEqual(officePopups[0]?.levelLabelKey, "announcements.levelWarning", "with the emphasis of the row");
  expectEqual(officePopups[0]?.publishedAtEpochMs, NOW - 2 * DAY, "and the instant it was published");
  expectEqual(
    officePopups.some((item) => item.id === announcementIdOf(4)),
    false,
    "a draft is not a popup",
  );
  expectEqual(
    officePopups.some((item) => item.id === announcementIdOf(5)),
    false,
    "an ended banner is not one either",
  );

  const ownerPopups = await listActiveAnnouncements({ actor: owner }, dependencies);

  expectEqual(
    ownerPopups.map((item) => item.id).join(","),
    [announcementIdOf(3), announcementIdOf(1)].join(","),
    "a merchant sees the merchant audience and everybody's",
  );
  expectEqual(
    ownerPopups.some((item) => item.id === announcementIdOf(2)),
    false,
    "and never an office only banner",
  );
  expectEqual(
    ownerPopups.some((item) => item.id === announcementIdOf(6)),
    false,
    "nor a notice written for another company",
  );
  expectEqual(
    (await listActiveAnnouncements({ actor: ceo }, dependencies)).map((item) => item.id).join(","),
    [announcementIdOf(2), announcementIdOf(1)].join(","),
    "the chief executive reads the office audience",
  );

  // ---- beating the cap
  const many = createDatabase();

  for (let index = 1; index <= 5; index += 1) {
    rowsOf(many, "announcements").push(
      announcementRow({
        id: announcementIdOf(index),
        title: `Banner ${String(index)}`,
        published_at: new Date(NOW - index * DAY).toISOString(),
      }),
    );
  }

  const capped = await listActiveAnnouncements({ actor: support }, createDependencies(many));

  expectEqual(capped.length, ANNOUNCEMENT_POPUP_LIMIT, "one page load shows at most three banners");
  expectEqual(capped[0]?.id, announcementIdOf(1), "the newest of them first");

  // ---- dismissal
  const dismissed = await dismissAnnouncement(
    { actor: support, announcementId: announcementIdOf(1) },
    dependencies,
  );
  const dismissalRow = rowsOf(database, "announcement_dismissals")[0];

  expectEqual(dismissed.recorded, true, "the first dismissal writes a row");
  expectEqual(dismissalRow?.["announcement_id"], announcementIdOf(1), "for that announcement");
  expectEqual(dismissalRow?.["user_id"], SUPPORT_ID, "and that person");
  expectEqual(dismissalRow?.["company_id"], null, "with the company they act for, which an officer has none of");
  expectEqual(dismissalRow?.["dismissed_at"], NOW_ISO, "at the instant they closed it");
  expectEqual(
    database.audits.entries.at(-1)?.action,
    "announcement.dismissed",
    "the dismissal is on the audit trail",
  );
  expectEqual(
    (await listActiveAnnouncements({ actor: support }, dependencies)).map((item) => item.id).join(","),
    announcementIdOf(2),
    "and it does not appear again for that person",
  );
  expectEqual(
    (await listActiveAnnouncements({ actor: ceo }, dependencies)).map((item) => item.id).join(","),
    [announcementIdOf(2), announcementIdOf(1)].join(","),
    "while everybody else still sees it",
  );

  const auditsBefore = database.audits.entries.length;
  const repeated = await dismissAnnouncement(
    { actor: support, announcementId: announcementIdOf(1) },
    dependencies,
  );

  expectEqual(repeated.recorded, false, "a second dismissal writes nothing");
  expectEqual(database.audits.entries.length, auditsBefore, "and records nothing");
  expectEqual(rowsOf(database, "announcement_dismissals").length, 1, "the unique index keeps one row");

  expectEqual(
    await failureOf(() =>
      dismissAnnouncement({ actor: support, announcementId: announcementIdOf(4) }, dependencies),
    ),
    "RESOURCE_NOT_FOUND|",
    "a draft cannot be dismissed, because it was never shown",
  );
  expectEqual(
    await failureOf(() =>
      dismissAnnouncement({ actor: support, announcementId: announcementIdOf(6) }, dependencies),
    ),
    "RESOURCE_NOT_FOUND|",
    "nor can another company's notice",
  );
  expectEqual(
    await failureOf(() =>
      dismissAnnouncement({ actor: support, announcementId: "018f2b8a-6666-4c2d-9c3e-999999999999" }, dependencies),
    ),
    "RESOURCE_NOT_FOUND|",
    "and nothing that is not there",
  );

  const merchantDismissal = await dismissAnnouncement(
    { actor: owner, announcementId: announcementIdOf(3) },
    createDependencies(database),
  );

  expectEqual(merchantDismissal.recorded, true, "a merchant may dismiss their own banner");
  expectEqual(
    rowsOf(database, "announcement_dismissals").at(-1)?.["company_id"],
    COMPANY_ID,
    "and the row says which company they act for",
  );
}

/** ---- The source contract: the route, the screens, the popup and the tables it rests on. */
async function checkSources(): Promise<void> {
  const route = await readRepositoryFile("app/api/office/announcements/route.ts");
  const page = await readRepositoryFile("app/(admin)/announcements/page.tsx");
  const composer = await readRepositoryFile("app/(admin)/announcements/announcement-composer.tsx");
  const popup = await readRepositoryFile("components/announcements/announcement-popup.tsx");
  const shell = await readRepositoryFile("components/office/admin-shell.tsx");
  const layout = await readRepositoryFile("app/(admin)/layout.tsx");
  const service = await readRepositoryFile("lib/announcements/service.ts");
  const tableSource = await readRepositoryFile("migrations/0007_announcements.sql");
  const dismissalSource = await readRepositoryFile("migrations/0008_announcement_dismissals.sql");
  const policies = await readRepositoryFile("migrations/0073_office_and_secret_policies.sql");

  const sources: readonly (readonly [string, string])[] = [
    ["app/api/office/announcements/route.ts", route],
    ["app/(admin)/announcements/page.tsx", page],
    ["app/(admin)/announcements/announcement-composer.tsx", composer],
    ["components/announcements/announcement-popup.tsx", popup],
    ["app/(admin)/layout.tsx", layout],
    ["components/office/admin-shell.tsx", shell],
    ["lib/announcements/service.ts", service],
  ];

  for (const [path, source] of sources) {
    expectEqual(source.split("\n")[0], `// path: ${path}`, `${path} states its own path on its first line`);
    expectEqual(source.includes("dangerouslySetInnerHTML"), false, `${path} writes no markup from a string`);
    expectEqual(/console\.(log|info|warn|error|debug)\(/u.test(source), false, `${path} logs nothing`);
    expectEqual(source.includes("process.env"), false, `${path} reads no environment variable`);
    expectEqual(/:\s*any\b/u.test(source), false, `${path} writes no any`);
    expectEqual(/https?:\/\//u.test(source), false, `${path} names no absolute URL`);
    expectEqual(/[\u0080-\uFFFF]/u.test(source), false, `${path} is ASCII`);

    // The markers are assembled: `config/structure.json` forbids them in any source file.
    for (const marker of ["TO" + "DO", "FIX" + "ME"]) {
      expectEqual(source.includes(marker), false, `${path} carries no unfinished note`);
    }
  }

  expect(route.includes("requireCsrfToken"), "the route refuses a request without the double submit token");
  expect(route.includes("verifySensitiveRequest"), "and verifies the device proof");
  expect(route.includes("requireTrustedDevice"), "refusing an unproven browser");
  expect(route.includes("readRequestActor"), "it reads the session cookie");
  expect(route.includes("getAnnouncementsRuntime"), "and uses the one runtime");
  expect(route.includes("maximumBodyBytes"), "bounds the body before it parses it");
  expectEqual(route.split('"action"').length - 1 > 0, true, "and dispatches on the action");
  expectEqual(route.split('if (action === "').length - 1, 3, "with four actions behind three branches");
  expect(route.includes('action === "publish" || action === "withdraw"'), "two of which share a branch");
  expect(
    route.indexOf("requireCsrfToken(") < route.indexOf("readRequestActor("),
    "the token is checked before the session is looked up",
  );
  expect(
    route.indexOf("verifySensitiveRequest(") < route.indexOf("JSON.parse("),
    "and the proof before the body is parsed",
  );
  expect(
    CSRF_PROTECTED_PATHS.includes("/api/office/announcements"),
    "the route is on the CSRF list",
  );
  expect(isSensitivePath("/api/office/announcements"), "and on the device proof list");

  expect(page.includes("readOfficeActor"), "the page reads the account through the cached reader");
  expect(page.includes("listAnnouncements"), "and asks the service for the composer");
  expect(page.includes("<AnnouncementComposerConsole"), "which it renders");
  expectEqual(page.includes("<main"), false, "the page renders no landmark: the shell owns it");

  expectEqual(composer.split("\n")[1], '"use client";', "the composer is a client boundary");
  expectEqual(popup.split("\n")[1], '"use client";', "and so is the popup");
  expectEqual(composer.split('method: "POST"').length - 1, 1, "the composer has one call site");
  expectEqual(popup.split('method: "POST"').length - 1, 1, "and the popup one");
  expect(composer.includes("deviceProofHeaders"), "the composer signs its request");
  expect(popup.includes("deviceProofHeaders"), "the popup signs its request");
  expect(composer.includes("csrfHeaders"), "both carry the double submit token");
  expect(popup.includes("csrfHeaders"), "on every write");
  expect(popup.includes('role="dialog"'), "the banner is a dialog");
  expectEqual(popup.includes("aria-modal"), false, "which does not trap the keyboard");
  expect(popup.includes("aria-labelledby"), "and is named by its headline");
  expect(popup.includes("router.refresh()"), "a dismissal re-reads the server's answer");

  expect(shell.includes("<AnnouncementPopup"), "the office shell mounts the popup once");
  expect(shell.includes("announcements: readonly AnnouncementPopupView[]"), "from the list it is given");
  expect(layout.includes("readOfficeAnnouncements"), "and the layout reads that list");
  expect(layout.includes("announcements={announcements}"), "passing it down");

  expectEqual(/\.delete\(/u.test(service), false, "the service never deletes a row");
  expect(service.includes("requireAnyRole"), "it asks the permission helper");
  expect(service.includes("requireFreshReauthentication"), "and the step up helper");
  expect(service.includes("isConflictError"), "and reads the unique index as a repeated dismissal");

  // The tables and the policies this STEP builds on, rather than rewriting.
  expect(tableSource.includes("create table public.announcements"), "0007 is the announcement table");
  expect(tableSource.includes("published_at"), "with the publish instant");
  expect(tableSource.includes("expires_at"), "and the expiry");
  expect(dismissalSource.includes("create table public.announcement_dismissals"), "0008 is the dismissal table");
  expect(dismissalSource.includes("create unique index announcement_dismissals_key"), "with the one row per person rule");
  expect(
    policies.includes("create policy announcements_super_admin_all"),
    "0073 gives the super administrator the writes",
  );
  expect(
    policies.includes("create policy announcements_audience_select"),
    "and the audience the read",
  );
  expect(
    policies.includes("create policy announcement_dismissals_self_insert"),
    "while a person may write their own dismissal",
  );

  // The catalog must hold every key the two surfaces reference.
  const catalog = en.announcements as Readonly<Record<string, string>>;
  const referenced = new Set<string>();

  for (const source of [page, composer, popup, service, await readRepositoryFile("lib/announcements/registry.ts")]) {
    for (const match of source.matchAll(/"announcements\.([a-zA-Z0-9_]+)"/gu)) {
      referenced.add(match[1] ?? "");
    }
  }

  expect(referenced.size > 30, "the two surfaces reference the block by name");
  expectEqual(
    [...referenced].filter((key) => !(key in catalog)).join(","),
    "",
    "and every key they reference is in the catalog",
  );
}

async function main(): Promise<void> {
  checkRegistry();
  await checkComposer();
  await checkPopup();
  await checkSources();

  if (failures.length > 0) {
    process.stderr.write(`announcements gate failed with ${failures.length} problem(s):\n`);

    for (const failure of failures) {
      process.stderr.write(`  - ${failure}\n`);
    }

    process.exitCode = 1;

    return;
  }

  process.stdout.write(
    `announcements gate passed: ${checks} checks, ${ANNOUNCEMENT_LEVELS.length} levels, ` +
      `${ANNOUNCEMENT_AUDIENCES.length} audiences, ${ANNOUNCEMENT_AUDIT_ACTIONS.length} audit names\n`,
  );
}

await main();
