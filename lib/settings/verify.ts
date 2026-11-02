// path: lib/settings/verify.ts
import { readFile } from "node:fs/promises";
import process from "node:process";
import type { z } from "zod";
import type { AuditEntry, AuditTrail } from "../auth/audit.ts";
import { isSensitivePath } from "../auth/request-proof.ts";
import { REAUTHENTICATION_REQUIRED_RULE, STEP_UP_WINDOW_MS } from "../auth/step-up.ts";
import type { PlatformRole, RequestActor } from "../auth/types.ts";
import { getMessage, type MessagePath } from "../i18n/messages.ts";
import { en } from "../i18n/strings/en.ts";
import { CSRF_PROTECTED_PATHS } from "../security/csrf.ts";
import {
  COMPLIANCE_ALERT_MAXIMUM_DAYS,
  COMPLIANCE_ALERT_MINIMUM_DAYS,
  COMPLIANCE_CALENDAR_LIMIT,
  COMPLIANCE_CALENDAR_MANAGE_ROLES,
  COMPLIANCE_CALENDAR_READ_ROLES,
  COMPLIANCE_DEFAULT_ALERT_DAYS,
  COMPLIANCE_ISSUER_MAXIMUM_LENGTH,
  COMPLIANCE_ITEM_KINDS,
  COMPLIANCE_ITEM_STATUSES,
  COMPLIANCE_NOTE_MAXIMUM_LENGTH,
  COMPLIANCE_REFERENCE_MAXIMUM_LENGTH,
  COMPLIANCE_TITLE_MAXIMUM_LENGTH,
  PLATFORM_INFORMATION_FIELDS,
  PLATFORM_INFORMATION_ROLES,
  PLATFORM_SETTINGS_SCREEN_ROLES,
  PLATFORM_SETTING_KEYS,
  SETTINGS_AUDIT_ACTIONS,
  SETTING_KEY_PATTERN,
  alertDaysProblemOf,
  calendarDayOf,
  complianceKindLabelKey,
  complianceStateLabelKey,
  complianceStateOf,
  complianceStatusLabelKey,
  dayNumberOf,
  daysUntil,
  isCalendarDay,
  isComplianceItemKind,
  isComplianceItemStatus,
  platformSettingFieldOf,
  settingValueProblemOf,
  type ComplianceState,
} from "./registry.ts";
import {
  addComplianceItem,
  archiveComplianceItem,
  readComplianceCalendar,
  readPlatformInformation,
  renewComplianceItem,
  runComplianceCalendarCheck,
  savePlatformInformation,
  type SettingsDependencies,
  type SettingsStore,
} from "./service.ts";

/**
 * The settings and compliance calendar gate: run with `node lib/settings/verify.ts`.
 *
 * Sections 24 and 3 are five sentences, and each of them is a property no screen can show:
 *
 *   1. **The platform information is the super administrator's alone.** Section 24 says so, `0080`
 *      says so in SQL, and every write here refuses every other role before it writes anything.
 *   2. **Only what changed is written.** An untouched field keeps its row, its version and the name of
 *      whoever last touched it, and a second save of the same values changes nothing.
 *   3. **A save is audited, once, by key.** A refused or empty save writes no audit entry, so the trail
 *      reads as a list of things somebody changed.
 *   4. **A renewal is a new row.** `0068`'s state machine is what section 3's calendar rests on: an
 *      expiry moves forward only, a renewal files the next period and closes the old row, and nothing
 *      is ever deleted.
 *   5. **A warning is stamped once.** Section 27's check expires what lapsed and stamps what is inside
 *      its own alert window, and a second run finds nothing to warn about - which is what stops a
 *      later sender from repeating a warning a person already acted on.
 *
 * The service runs over an in-memory PostgREST with the four methods `RestClient` exposes, so what
 * passes here is the code the two routes run. The screens, the routes and the migration are read as
 * source, because a `.tsx` file cannot be imported by plain Node and a migration is a document until
 * it is applied.
 *
 * ## What it cannot prove
 *
 * That PostgREST is reachable, that `0099` was applied to a particular project, and that a person can
 * press the buttons at both widths - those are deployment and browser facts, and the handoff lists the
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

/** The instant every scenario runs at, so an expiry assertion is exact. */
const NOW = 1_800_000_000_000;
const NOW_ISO = new Date(NOW).toISOString();
const TODAY = calendarDayOf(NOW);

const SUPER_ADMIN_ID = "018f2b8a-1111-4c2d-9c3e-000000000001";
const CEO_ID = "018f2b8a-1111-4c2d-9c3e-000000000002";
const DESK_ID = "018f2b8a-1111-4c2d-9c3e-000000000003";
const FINANCE_ID = "018f2b8a-1111-4c2d-9c3e-000000000004";

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
const complianceDesk = actorOf(["compliance_kyc"], { userId: DESK_ID });
const ceo = actorOf(["ceo"], { userId: CEO_ID });
const finance = actorOf(["finance_ops"], { userId: FINANCE_ID });
const staleSuperAdmin = actorOf(["super_admin"], {
  mfaVerifiedAtEpochMs: NOW - STEP_UP_WINDOW_MS - 1,
  reauthenticatedAtEpochMs: NOW - STEP_UP_WINDOW_MS - 1,
});
const staleDesk = actorOf(["compliance_kyc"], {
  userId: DESK_ID,
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
  readonly operator: "eq" | "in" | "isNull";
  readonly values: readonly string[];
}

/** The operators this module's queries use: `eq`, `in` and `is.null`, and nothing else. */
function parseFilters(query: string): {
  readonly filters: readonly Filter[];
  readonly limit: number;
  readonly order: string | null;
} {
  const filters: Filter[] = [];
  let limit = 1_000;
  let order: string | null = null;

  for (const part of query.split("&")) {
    if (part.startsWith("order=")) {
      order = part.slice("order=".length).split(".")[0] ?? null;
      continue;
    }

    if (part.length === 0 || part.startsWith("select=") || part.startsWith("offset=")) {
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

    if (filter.operator === "isNull") {
      return value === null || value === undefined;
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
    tables: { platform_settings: [], compliance_items: [] },
    queries: [],
    writes: [],
    updateColumns: [],
    audits: createAudit(),
    nextId: 1,
  };
}

/** The store: PostgREST's four methods, `set_row_metadata`'s version bump, and no other behaviour. */
function createStore(database: FakeDatabase): SettingsStore {
  return {
    select<TRow>(table: string, query: string, schema: z.ZodType<TRow>): Promise<readonly TRow[]> {
      database.queries.push(`${table}?${query}`);

      const rows = rowsOf(database, table);
      const { filters, limit, order } = parseFilters(query);
      const matched = rows.filter((row) => matches(row, filters));

      // `order=column.asc` is the only ordering this module asks PostgREST for, and it is the whole
      // point of the calendar: the nearest lapse comes first.
      if (order !== null) {
        matched.sort((left, right) =>
          String(left[order] ?? "").localeCompare(String(right[order] ?? "")),
        );
      }

      return Promise.resolve(matched.slice(0, limit).map((row) => schema.parse(row)));
    },
    insert(table: string, rows: readonly Row[]): Promise<void> {
      database.writes.push(`insert ${table} ${String(rows.length)}`);

      for (const row of rows) {
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

      const rows = rowsOf(database, table);
      const { filters } = parseFilters(query);

      for (const row of rows) {
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

/** The rows of one table, so a scenario never indexes a table that may be absent. */
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
    // The nullable columns of both tables, so a row the service inserts parses back the way Postgres
    // would return it rather than arriving with columns missing.
    reference: null,
    note: null,
    document_file_id: null,
    owner_id: null,
    last_alert_at: null,
    renewed_at: null,
    ...row,
    id: typeof row["id"] === "string" ? row["id"] : id,
  };
}

function createDependencies(database: FakeDatabase): SettingsDependencies {
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

/** A `platform_settings` row, as `0080` defines it. */
function settingRow(overrides: Row = {}): Row {
  return {
    id: `018f2b8a-4444-4c2d-9c3e-${String(settingRow.counter).padStart(12, "0")}`,
    setting_key: "platform.name",
    value: "KD Solution IT",
    is_secret: false,
    updated_by: SUPER_ADMIN_ID,
    company_id: null,
    deleted_at: null,
    created_at: NOW_ISO,
    updated_at: NOW_ISO,
    version: 1,
    ...overrides,
  };
}

settingRow.counter = 1;

/** A `compliance_items` row, as `0068` defines it. */
function itemRow(overrides: Row = {}): Row {
  return {
    id: `018f2b8a-5555-4c2d-9c3e-${String(itemRow.counter).padStart(12, "0")}`,
    company_id: null,
    kind: "cyber_insurance",
    title: "Cyber liability policy 2026",
    issuer: "Northbridge Assurance",
    reference: "NB-CY-2026-118",
    issued_on: "2025-07-01",
    expires_on: "2026-07-01",
    alert_days: COMPLIANCE_DEFAULT_ALERT_DAYS,
    status: "active",
    document_file_id: null,
    owner_id: SUPER_ADMIN_ID,
    last_alert_at: null,
    renewed_at: null,
    note: null,
    deleted_at: null,
    created_at: NOW_ISO,
    updated_at: NOW_ISO,
    version: 1,
    ...overrides,
  };
}

itemRow.counter = 1;

function itemIdOf(index: number): string {
  return `018f2b8a-6666-4c2d-9c3e-${String(index).padStart(12, "0")}`;
}

/** A day `offset` days from today, as the calendar prints it. */
function dayFromToday(offset: number): string {
  return calendarDayOf(NOW + offset * 86_400_000);
}

/** ---- The registry: keys the column accepts, labels the catalog has, arithmetic that agrees. */
function checkRegistry(): void {
  expectEqual(PLATFORM_INFORMATION_ROLES.join(","), "super_admin", "section 24 is the super administrator's");
  expectEqual(
    COMPLIANCE_CALENDAR_MANAGE_ROLES.join(","),
    "super_admin,compliance_kyc",
    "the calendar is worked by the super administrator and the compliance desk",
  );
  expectEqual(
    COMPLIANCE_CALENDAR_READ_ROLES.join(","),
    "ceo,compliance_kyc,super_admin",
    "and read by the CEO as well",
  );
  expectEqual(
    PLATFORM_SETTINGS_SCREEN_ROLES.join(","),
    "ceo,compliance_kyc,super_admin",
    "the screen is the union of its two halves",
  );
  expect(
    PLATFORM_SETTINGS_SCREEN_ROLES.every(
      (role) =>
        PLATFORM_INFORMATION_ROLES.includes(role) || COMPLIANCE_CALENDAR_READ_ROLES.includes(role),
    ),
    "every role the screen offers may open one of its halves",
  );
  expect(
    PLATFORM_INFORMATION_ROLES.every((role) => PLATFORM_SETTINGS_SCREEN_ROLES.includes(role)),
    "and the settings half is inside the screen's list",
  );
  expect(
    COMPLIANCE_CALENDAR_MANAGE_ROLES.every((role) => COMPLIANCE_CALENDAR_READ_ROLES.includes(role)),
    "whoever may work the calendar may read it",
  );
  expect(
    COMPLIANCE_CALENDAR_READ_ROLES.includes("ceo") && !COMPLIANCE_CALENDAR_MANAGE_ROLES.includes("ceo"),
    "the CEO reads and does not write, because section 2 makes the CEO a confirmer",
  );
  expect(Object.isFrozen(PLATFORM_SETTINGS_SCREEN_ROLES), "the screen's role list is frozen");
  expect(Object.isFrozen(PLATFORM_INFORMATION_FIELDS), "the field list is frozen");
  expect(Object.isFrozen(COMPLIANCE_ITEM_KINDS), "the kind list is frozen");
  expect(Object.isFrozen(COMPLIANCE_ITEM_STATUSES), "the status list is frozen");
  expect(Object.isFrozen(SETTINGS_AUDIT_ACTIONS), "the audit list is frozen");
  expectEqual(new Set<string>(PLATFORM_INFORMATION_ROLES).size, 1, "one role, once");

  const auditPattern = /^[a-z][a-z0-9]*(\.[a-z0-9_]+)+$/u;

  for (const action of SETTINGS_AUDIT_ACTIONS) {
    expect(auditPattern.test(action), `${action} is a valid audit name`);
    expect(action.length <= 64, `${action} fits the audit column`);
  }

  expectEqual(
    new Set<string>(SETTINGS_AUDIT_ACTIONS).size,
    SETTINGS_AUDIT_ACTIONS.length,
    "no audit name is used twice",
  );
  expectEqual(SETTINGS_AUDIT_ACTIONS.length, 6, "six things this STEP records");

  const keys = new Set<string>();
  const labelKeys = new Set<string>();

  for (const field of PLATFORM_INFORMATION_FIELDS) {
    expect(SETTING_KEY_PATTERN.test(field.key), `${field.key} is a key platform_settings accepts`);
    expect(field.key.length >= 3 && field.key.length <= 64, `${field.key} fits the key column`);
    expect(!keys.has(field.key), `${field.key} is declared once`);
    keys.add(field.key);
    expect(field.group === "platform" || field.group === "officer", `${field.key} has a block`);
    expect(field.maxLength > 0 && field.maxLength <= 500, `${field.key} is bounded`);
    expect(!labelKeys.has(field.labelKey), `${field.key} has its own label`);
    labelKeys.add(field.labelKey);
    expect(getMessage(field.labelKey as MessagePath).length > 0, `${field.labelKey} is in the catalog`);
    expectEqual(
      (getMessage(field.labelKey as MessagePath).match(/\{/gu) ?? []).length,
      0,
      `${field.labelKey} needs no placeholder`,
    );

    if (field.hintKey !== null) {
      expect(getMessage(field.hintKey as MessagePath).length > 0, `${field.hintKey} is in the catalog`);
      expectEqual(
        (getMessage(field.hintKey as MessagePath).match(/\{/gu) ?? []).length,
        0,
        `${field.hintKey} needs no placeholder`,
      );
    }

    // The default is what a fresh deployment renders, so it has to pass the field's own rule - unless
    // it is empty on purpose, because nobody has been named yet and the field demands a name.
    const problem = settingValueProblemOf({
      kind: field.kind,
      value: field.default,
      required: field.required,
      maxLength: field.maxLength,
    });

    expect(
      problem === null || (field.default === "" && problem === "required"),
      `${field.key} defaults to a value its own rule accepts`,
    );
  }

  expectEqual(PLATFORM_INFORMATION_FIELDS.length, 10, "ten fields make up the platform's identity");
  expectEqual(
    PLATFORM_INFORMATION_FIELDS.filter((field) => field.default === "").length,
    5,
    "five start empty because a deployment has not filled them in yet",
  );
  expectEqual(
    PLATFORM_INFORMATION_FIELDS.filter((field) => field.group === "platform").length,
    7,
    "seven of them say what the platform is",
  );
  expectEqual(
    PLATFORM_INFORMATION_FIELDS.filter((field) => field.group === "officer").length,
    3,
    "and three record section 3's appointed officer",
  );
  expectEqual(
    PLATFORM_SETTING_KEYS.join(","),
    PLATFORM_INFORMATION_FIELDS.map((field) => field.key).join(","),
    "the key list is the field list in form order",
  );
  expectEqual(platformSettingFieldOf("platform.name")?.key, "platform.name", "a field is found by key");
  expectEqual(platformSettingFieldOf("platform.nope"), null, "and an unknown key is nothing");
  expectEqual(platformSettingFieldOf("compliance.officer_email")?.required, true, "the officer needs an address");
  expectEqual(platformSettingFieldOf("platform.website")?.required, false, "the website may be absent");

  for (const kind of COMPLIANCE_ITEM_KINDS) {
    const label = getMessage(complianceKindLabelKey(kind));

    expect(label.length > 0, `${kind} has a label`);
    expect(isComplianceItemKind(kind), `${kind} is a tracked kind`);
  }

  for (const status of COMPLIANCE_ITEM_STATUSES) {
    expect(getMessage(complianceStatusLabelKey(status)).length > 0, `${status} has a label`);
    expect(isComplianceItemStatus(status), `${status} is a status`);
  }

  const states: readonly ComplianceState[] = ["ok", "due", "overdue"];

  for (const state of states) {
    expect(getMessage(complianceStateLabelKey(state)).length > 0, `${state} has a label`);
  }

  expectEqual(isComplianceItemKind("passport"), false, "an unknown kind is refused");
  expectEqual(isComplianceItemStatus("closed"), false, "and an unknown status");
  expectEqual(isComplianceItemKind(null), false, "as is a value that is not even a string");

  // ---- the day arithmetic
  expect(isCalendarDay("2024-02-29"), "the leap day of a leap year is a day");
  expect(!isCalendarDay("2023-02-29"), "and the one that does not exist is not");
  expect(!isCalendarDay("2026-02-30"), "nor is the thirtieth of February");
  expect(!isCalendarDay("2026-13-01"), "nor a thirteenth month");
  expect(!isCalendarDay("2026-1-01"), "nor a day written short");
  expect(!isCalendarDay(""), "nor an empty value");
  expect(!isCalendarDay("2026-01-01T00:00:00Z"), "nor an instant where a day belongs");
  expectEqual(dayNumberOf("1970-01-02"), 1, "the day number counts days from the epoch");
  expectEqual(dayNumberOf("1970-01-01"), 0, "with the epoch itself at zero");
  expectEqual(dayNumberOf("not-a-day"), null, "and nothing for a value that is not a day");
  expectEqual(calendarDayOf(0), "1970-01-01", "an instant is printed as its UTC day");
  expectEqual(daysUntil("2026-01-11", "2026-01-01"), 10, "ten days is ten days");
  expectEqual(daysUntil("2026-01-01", "2026-01-11"), -10, "and the other way round is negative");
  expectEqual(daysUntil("2026-03-01", "2026-02-28"), 1, "across a month end");
  expectEqual(daysUntil("2024-03-01", "2024-02-28"), 2, "and across a leap day");
  expectEqual(daysUntil("nope", "2026-01-01"), null, "unreadable input has no answer");

  // ---- the value rules
  const ruleOf = (
    kind: "name" | "text" | "email" | "phone" | "path" | "url" | "date",
    value: string,
  ): string | null =>
    settingValueProblemOf({ kind, value, required: false, maxLength: 254 });

  expectEqual(ruleOf("email", "support@kd-solution.example"), null, "an address with an at sign and a dot passes");
  expectEqual(ruleOf("email", "support at kd"), "invalid_format", "a sentence is not an address");
  expectEqual(ruleOf("phone", "+880 1700 000000"), null, "a phone with punctuation passes");
  expectEqual(ruleOf("phone", "call us"), "invalid_format", "letters do not");
  expectEqual(ruleOf("path", "/brand/logo.svg"), null, "a rooted path passes");
  expectEqual(ruleOf("path", "https://cdn.example/logo.svg"), "invalid_format", "an absolute URL does not");
  expectEqual(ruleOf("path", "/a/../b"), "invalid_format", "and neither does a traversal");
  expectEqual(ruleOf("path", "//evil.example/x"), "invalid_format", "nor a protocol relative path");
  expectEqual(ruleOf("url", "https://kd-solution.example"), null, "an https address passes");
  expectEqual(ruleOf("url", "http://kd-solution.example"), "invalid_format", "and plain http does not");
  expectEqual(ruleOf("url", "javascript:alert(1)"), "invalid_format", "nor does a script URL");
  expectEqual(ruleOf("date", "2026-04-30"), null, "a day that exists passes");
  expectEqual(ruleOf("date", "2026-04-31"), "invalid_date", "and one that does not is its own rule");
  expectEqual(ruleOf("name", "KD \u0007 Solution"), "invalid_format", "a control character is refused");
  expectEqual(
    settingValueProblemOf({ kind: "name", value: "", required: true, maxLength: 80 }),
    "required",
    "an empty required field is a refusal",
  );
  expectEqual(
    settingValueProblemOf({ kind: "name", value: "   ", required: false, maxLength: 80 }),
    null,
    "and an empty optional one is a cleared field",
  );
  expectEqual(
    settingValueProblemOf({ kind: "text", value: "a".repeat(81), required: false, maxLength: 80 }),
    "too_long",
    "a value longer than its field is refused",
  );

  // ---- the calendar's own bounds
  expectEqual(COMPLIANCE_ALERT_MINIMUM_DAYS, 7, "a warning starts a week out");
  expectEqual(COMPLIANCE_ALERT_MAXIMUM_DAYS, 365, "and ends a year out");
  expect(
    COMPLIANCE_DEFAULT_ALERT_DAYS >= COMPLIANCE_ALERT_MINIMUM_DAYS &&
      COMPLIANCE_DEFAULT_ALERT_DAYS <= COMPLIANCE_ALERT_MAXIMUM_DAYS,
    "the default window is inside the column's bounds",
  );
  expectEqual(alertDaysProblemOf(COMPLIANCE_DEFAULT_ALERT_DAYS), null, "and passes its own check");
  expectEqual(alertDaysProblemOf(6), "invalid_range", "six days is too close");
  expectEqual(alertDaysProblemOf(366), "invalid_range", "and three hundred and sixty six too far");
  expectEqual(alertDaysProblemOf(30.5), "invalid_format", "a fraction of a day is not a window");
  expectEqual(COMPLIANCE_TITLE_MAXIMUM_LENGTH, 120, "the title's ceiling is the column's");
  expectEqual(COMPLIANCE_ISSUER_MAXIMUM_LENGTH, 120, "and so is the issuer's");
  expectEqual(COMPLIANCE_REFERENCE_MAXIMUM_LENGTH, 120, "the reference's");
  expectEqual(COMPLIANCE_NOTE_MAXIMUM_LENGTH, 500, "and the note's");
  expectEqual(COMPLIANCE_CALENDAR_LIMIT, 200, "one calendar read is bounded");

  // ---- the state a row is in today
  expectEqual(
    complianceStateOf({ expiresOn: dayFromToday(120), today: TODAY, alertDays: 30, status: "active" }),
    "ok",
    "a certificate months away is in good time",
  );
  expectEqual(
    complianceStateOf({ expiresOn: dayFromToday(20), today: TODAY, alertDays: 30, status: "active" }),
    "due",
    "one inside its own window is due",
  );
  expectEqual(
    complianceStateOf({ expiresOn: dayFromToday(-1), today: TODAY, alertDays: 30, status: "active" }),
    "overdue",
    "and one behind us is overdue even before the check moves it",
  );
  expectEqual(
    complianceStateOf({ expiresOn: dayFromToday(200), today: TODAY, alertDays: 30, status: "expired" }),
    "overdue",
    "an expired row stays overdue whatever its dates say",
  );
  expectEqual(
    complianceStateOf({ expiresOn: dayFromToday(-1), today: TODAY, alertDays: 30, status: "renewed" }),
    "overdue",
    "and a renewed row's old period is in the past",
  );

  // ---- the copy the two halves render
  const required: readonly MessagePath[] = [
    "office.sectionSettings",
    "office.sectionSettingsDescription",
    "officeSettings.title",
    "officeSettings.description",
    "officeSettings.settingsHeading",
    "officeSettings.officerHeading",
    "officeSettings.calendarHeading",
    "officeSettings.calendarDescription",
    "officeSettings.saveSubmit",
    "officeSettings.staleSave",
    "officeSettings.addSubmit",
    "officeSettings.renewSubmit",
    "officeSettings.archiveSubmit",
    "officeSettings.checkSubmit",
    "officeSettings.listEmpty",
    "officeSettings.panelEmpty",
    "officeSettings.notManageable",
    "officeSettings.forbidden",
    "officeSettings.signedOut",
  ];

  // The raw templates, because a message with a placeholder cannot be read through `getMessage`.
  const templates: Readonly<Record<string, string>> = {
    ...Object.fromEntries(
      Object.entries(en.office as Readonly<Record<string, string>>).map(([key, value]) => [
        `office.${key}`,
        value,
      ]),
    ),
    ...Object.fromEntries(
      Object.entries(en.officeSettings as Readonly<Record<string, string>>).map(([key, value]) => [
        `officeSettings.${key}`,
        value,
      ]),
    ),
  };

  for (const path of required) {
    const message = templates[path] ?? "";

    expect(message.length > 0, `${path} is in the catalog`);
    expectEqual(message, message.trim(), `${path} is trimmed`);
    expectEqual(message.includes("  "), false, `${path} has no double space`);
    expectEqual(
      (message.match(/\{/gu) ?? []).length,
      0,
      `${path} is a sentence the screen renders whole`,
    );
    expectEqual(getMessage(path), message, `${path} reads back unchanged`);
  }

  const placeholders = [
    "officeSettings.savedAt",
    "officeSettings.todayLine",
    "officeSettings.checkDone",
    "officeSettings.daysLeft",
    "officeSettings.daysOverdue",
    "officeSettings.alertWindow",
    "officeSettings.lastAlert",
    "officeSettings.listCount",
  ];

  for (const path of placeholders) {
    expect(/\{[a-zA-Z][a-zA-Z0-9]*\}/u.test(templates[path] ?? ""), `${path} keeps its placeholders`);
  }
}

/** ---- The settings half: defaults, the one role, and only what changed. */
async function checkSettingsRead(): Promise<void> {
  const database = createDatabase();
  const dependencies = createDependencies(database);

  const empty = await readPlatformInformation({ actor: superAdmin }, dependencies);

  expectEqual(empty.fields.length, 10, "a fresh deployment reads ten fields");
  expectEqual(empty.savedAtEpochMs, null, "and says nobody has saved anything");
  expectEqual(empty.readAtEpochMs, NOW, "while naming the instant it read at");
  expectEqual(empty.canEdit, true, "and that the super administrator may save");
  expect(
    empty.fields.every((field) => !field.isSet),
    "every field is still its default",
  );
  expectEqual(empty.fields[0]?.value, "KD Solution IT", "so the first field shows the platform's name");
  expectEqual(empty.fields[0]?.labelKey, "officeSettings.fieldName", "with its catalog label");
  expectEqual(empty.fields[0]?.maxLength, 80, "and the length its column allows");
  expectEqual(database.queries.length, 1, "one query reads the whole form");

  expectEqual(
    await failureOf(() => readPlatformInformation({ actor: ceo }, dependencies)),
    "PERMISSION_DENIED|",
    "the chief executive may not read section 24's settings",
  );
  expectEqual(
    await failureOf(() => readPlatformInformation({ actor: complianceDesk }, dependencies)),
    "PERMISSION_DENIED|",
    "nor may the compliance desk",
  );
  expectEqual(
    await failureOf(() => readPlatformInformation({ actor: finance }, dependencies)),
    "PERMISSION_DENIED|",
    "nor finance",
  );

  database.tables["platform_settings"] = [
    settingRow({ setting_key: "platform.name", value: "KD Solution IT Ltd", updated_at: NOW_ISO }),
    settingRow({
      setting_key: "platform.website",
      value: "https://kd-solution.example",
      updated_at: new Date(NOW + 60_000).toISOString(),
    }),
  ];

  const seeded = await readPlatformInformation({ actor: superAdmin }, dependencies);

  expectEqual(seeded.savedAtEpochMs, NOW + 60_000, "the newest save is the instant the form compares against");
  expectEqual(
    seeded.fields.find((field) => field.key === "platform.name")?.value,
    "KD Solution IT Ltd",
    "a saved value is what the form shows",
  );
  expectEqual(
    seeded.fields.find((field) => field.key === "platform.name")?.isSet,
    true,
    "and is marked as saved",
  );
  expectEqual(
    seeded.fields.find((field) => field.key === "platform.address")?.isSet,
    false,
    "while a field nobody saved is still the default",
  );
  expect(
    database.queries.some((query) => query.includes("is_secret=eq.false")),
    "secrets are never read by this screen",
  );
}

async function checkSettingsSave(): Promise<void> {
  const database = createDatabase();
  const dependencies = createDependencies(database);
  const values = Object.fromEntries(
    PLATFORM_INFORMATION_FIELDS.map((field) => [
      field.key,
      field.default === "" && field.required
        ? field.kind === "email"
          ? "gate@kd-solution.example"
          : "Filled in by the gate"
        : field.default,
      // The two required officer fields start empty, so a whole-form save names somebody.
    ]),
  );

  // A save that changes nothing writes nothing and audits nothing.
  const unchanged = await savePlatformInformation(
    { actor: superAdmin, values: { "platform.name": "KD Solution IT" }, expectedSavedAtEpochMs: null },
    dependencies,
  );

  expectEqual(database.writes.length, 1, "a first save inserts the one row it needs");
  expectEqual(database.audits.entries.length, 1, "and records it once");
  expectEqual(
    database.audits.entries[0]?.action,
    "platform.settings_updated",
    "under the settings audit name",
  );
  expectEqual(unchanged.fields[0]?.isSet, true, "the answer is the saved form");

  const before = database.writes.length;
  const auditsBefore = database.audits.entries.length;

  await savePlatformInformation(
    { actor: superAdmin, values: { "platform.name": "KD Solution IT" }, expectedSavedAtEpochMs: null },
    dependencies,
  );

  expectEqual(database.writes.length, before, "saving the value it already holds writes nothing");
  expectEqual(database.audits.entries.length, auditsBefore, "and records nothing");

  await savePlatformInformation(
    {
      actor: superAdmin,
      values: { "platform.name": "KD Solution IT", "platform.address": "House 12, Road 5, Dhaka" },
      expectedSavedAtEpochMs: null,
    },
    dependencies,
  );

  expectEqual(
    JSON.stringify(database.audits.entries.at(-1)?.payload?.["changed_keys"]),
    JSON.stringify(["platform.address"]),
    "only the changed key is in the audit entry",
  );
  expectEqual(
    database.audits.entries.at(-1)?.payload?.["officer_changed"],
    false,
    "and the officer flag stays false when no officer field moved",
  );
  expect(
    rowsOf(database, "platform_settings").some(
      (row) => row["setting_key"] === "platform.address" && row["value"] === "House 12, Road 5, Dhaka",
    ),
    "the changed key is stored",
  );
  expect(
    rowsOf(database, "platform_settings").find((row) => row["setting_key"] === "platform.name")?.[
      "version"
    ] === 1,
    "while the untouched row keeps its version",
  );

  // The officer block is flagged, because section 3 asks who is answerable.
  await savePlatformInformation(
    {
      actor: superAdmin,
      values: { "compliance.officer_name": "Nusrat Jahan", "compliance.officer_email": "nusrat@kd-solution.example" },
      expectedSavedAtEpochMs: null,
    },
    dependencies,
  );

  expectEqual(
    database.audits.entries.at(-1)?.payload?.["officer_changed"],
    true,
    "a change to the appointed officer is flagged in the entry",
  );

  // A row that is not a string this screen wrote reads as unset rather than being rendered as JSON.
  rowsOf(database, "platform_settings").push(
    settingRow({ setting_key: "platform.website", value: { url: "https://x.example" } }),
  );

  const odd = await readPlatformInformation({ actor: superAdmin }, dependencies);

  expectEqual(
    odd.fields.find((field) => field.key === "platform.website")?.isSet,
    false,
    "a value that is not a string is treated as unset",
  );

  // ---- the refusals
  expectEqual(
    await failureOf(() =>
      savePlatformInformation(
        { actor: superAdmin, values: { "platform.theme": "dark" }, expectedSavedAtEpochMs: null },
        dependencies,
      ),
    ),
    "VALIDATION_FAILED|unknown_key",
    "a key this module does not own is refused rather than written",
  );
  expectEqual(
    await failureOf(() =>
      savePlatformInformation(
        { actor: superAdmin, values: { "platform.support_email": "support at kd" }, expectedSavedAtEpochMs: null },
        dependencies,
      ),
    ),
    "VALIDATION_FAILED|invalid_format",
    "an address without an at sign is refused",
  );
  expectEqual(
    await failureOf(() =>
      savePlatformInformation(
        { actor: superAdmin, values: { "platform.name": "" }, expectedSavedAtEpochMs: null },
        dependencies,
      ),
    ),
    "VALIDATION_FAILED|required",
    "the platform's name cannot be emptied",
  );
  expectEqual(
    await failureOf(() =>
      savePlatformInformation(
        {
          actor: superAdmin,
          values: { "platform.address": "a".repeat(281) },
          expectedSavedAtEpochMs: null,
        },
        dependencies,
      ),
    ),
    "VALIDATION_FAILED|too_long",
    "and no field accepts more than its column",
  );
  expectEqual(
    await failureOf(() =>
      savePlatformInformation(
        { actor: superAdmin, values: { "platform.logo_path": "/a/../b" }, expectedSavedAtEpochMs: null },
        dependencies,
      ),
    ),
    "VALIDATION_FAILED|invalid_format",
    "a logo path that climbs out of the site is refused",
  );
  expectEqual(
    await failureOf(() =>
      savePlatformInformation(
        { actor: superAdmin, values: { "compliance.officer_appointed_on": "2026-02-30" }, expectedSavedAtEpochMs: null },
        dependencies,
      ),
    ),
    "VALIDATION_FAILED|invalid_date",
    "and the appointment day has to be a day that exists",
  );
  expectEqual(
    await failureOf(() =>
      savePlatformInformation(
        { actor: ceo, values: { "platform.name": "Not mine" }, expectedSavedAtEpochMs: null },
        dependencies,
      ),
    ),
    "PERMISSION_DENIED|",
    "the chief executive may not write the platform's identity",
  );
  expectEqual(
    await failureOf(() =>
      savePlatformInformation(
        { actor: complianceDesk, values: { "platform.name": "Not mine" }, expectedSavedAtEpochMs: null },
        dependencies,
      ),
    ),
    "PERMISSION_DENIED|",
    "nor may the compliance desk",
  );
  expectEqual(
    await failureOf(() =>
      savePlatformInformation(
        { actor: staleSuperAdmin, values: { "platform.name": "Stale" }, expectedSavedAtEpochMs: null },
        dependencies,
      ),
    ),
    `PERMISSION_DENIED|${REAUTHENTICATION_REQUIRED_RULE}`,
    "and a super administrator whose second factor has gone stale is asked to prove it again",
  );

  // ---- the staleness guard
  expectEqual(
    await failureOf(() =>
      savePlatformInformation(
        {
          actor: superAdmin,
          values: { "platform.name": "Raced" },
          expectedSavedAtEpochMs: NOW - 60_000,
        },
        dependencies,
      ),
    ),
    "CONFLICT|stale",
    "a form older than the newest save is refused instead of overwriting it",
  );
  expectEqual(
    await failureOf(() =>
      savePlatformInformation(
        { actor: superAdmin, values: { "platform.name": "Current" }, expectedSavedAtEpochMs: NOW + 60_000 },
        dependencies,
      ),
    ),
    "no-throw",
    "and a form at least as new as the newest save goes through",
  );

  // ---- a write that loses the race
  const race = createDatabase();

  race.tables["platform_settings"] = [settingRow({ setting_key: "platform.name", value: "Old name" })];
  race.beforeUpdate = (table: string): void => {
    if (table !== "platform_settings") {
      return;
    }

    const row = rowsOf(race, "platform_settings")?.[0];

    if (row !== undefined) {
      row["version"] = Number(row["version"] ?? 1) + 2;
    }
  };

  expectEqual(
    await failureOf(() =>
      savePlatformInformation(
        { actor: superAdmin, values: { "platform.name": "Raced" }, expectedSavedAtEpochMs: null },
        createDependencies(race),
      ),
    ),
    "CONFLICT|stale",
    "a save that another write overtook is a conflict, not a silent overwrite",
  );

  for (const columns of database.updateColumns) {
    expect(!columns.includes("version"), "no update sends version: the trigger owns the counter");
  }

  expectEqual(
    await failureOf(() =>
      savePlatformInformation(
        { actor: superAdmin, values: { ...values }, expectedSavedAtEpochMs: null },
        dependencies,
      ),
    ),
    "no-throw",
    "the whole form saves in one call",
  );
}

/** ---- The calendar half. */
function seedCalendar(database: FakeDatabase): void {
  database.tables["compliance_items"] = [
    itemRow({
      id: itemIdOf(1),
      kind: "cyber_insurance",
      title: "Cyber liability policy 2026",
      issued_on: dayFromToday(-300),
      expires_on: dayFromToday(200),
      status: "active",
    }),
    itemRow({
      id: itemIdOf(2),
      kind: "pci_attestation",
      title: "PCI DSS attestation 2026",
      issuer: "Qualified security assessor",
      reference: null,
      issued_on: dayFromToday(-350),
      expires_on: dayFromToday(20),
      alert_days: 30,
      status: "active",
    }),
    itemRow({
      id: itemIdOf(3),
      kind: "business_license",
      title: "Trade licence 2025",
      issued_on: dayFromToday(-400),
      expires_on: dayFromToday(-5),
      alert_days: 60,
      status: "active",
    }),
    itemRow({
      id: itemIdOf(4),
      kind: "annual_filing",
      title: "Annual return 2025",
      issued_on: dayFromToday(-380),
      expires_on: dayFromToday(-30),
      status: "renewed",
      renewed_at: NOW_ISO,
    }),
  ];
}

async function checkCalendarRead(): Promise<void> {
  const database = createDatabase();

  seedCalendar(database);

  const dependencies = createDependencies(database);
  const snapshot = await readComplianceCalendar({ actor: complianceDesk }, dependencies);

  expectEqual(snapshot.items.length, 4, "the calendar shows every row, closed ones included");
  expectEqual(snapshot.today, TODAY, "and names today");
  expectEqual(snapshot.readAtEpochMs, NOW, "and the instant it read at");
  expectEqual(snapshot.canManage, true, "the compliance desk may work it");
  expectEqual(
    snapshot.items.map((item) => item.id).join(","),
    [itemIdOf(4), itemIdOf(3), itemIdOf(2), itemIdOf(1)].join(","),
    "and rows are ordered by expiry, so the nearest lapse is first",
  );
  expectEqual(snapshot.overdueCount, 2, "two rows are behind us");
  expectEqual(snapshot.dueCount, 1, "one is inside its window");
  expectEqual(snapshot.unalertedCount, 1, "and it has never been warned about");
  expectEqual(snapshot.activeCount, 3, "three are still active");
  expectEqual(snapshot.items[2]?.state, "due", "the attestation twenty days out is due");
  expectEqual(snapshot.items[2]?.stateLabelKey, "officeSettings.stateDue", "with its catalog badge");
  expectEqual(snapshot.items[2]?.kindLabelKey, "officeSettings.kindPciAttestation", "and its kind's name");
  expectEqual(snapshot.items[2]?.statusLabelKey, "officeSettings.statusActive", "and its status");
  expectEqual(snapshot.items[2]?.daysRemaining, 20, "and the days it has left");
  expectEqual(snapshot.items[1]?.daysRemaining, -5, "while an expired one counts backwards");
  expectEqual(snapshot.items[0]?.status, "renewed", "a renewed row keeps its own status");
  expectEqual(snapshot.items[0]?.renewedAtEpochMs, NOW, "and the instant it was replaced");
  expectEqual(snapshot.items[3]?.lastAlertAtEpochMs, null, "nothing has been warned about yet");

  const ceoView = await readComplianceCalendar({ actor: ceo }, dependencies);

  expectEqual(ceoView.canManage, false, "the chief executive reads the calendar without the forms");
  expectEqual(
    await failureOf(() => readComplianceCalendar({ actor: finance }, dependencies)),
    "PERMISSION_DENIED|",
    "and finance may not read it at all",
  );
  expect(
    database.queries.every((query) => query.includes("company_id=is.null")),
    "the calendar is the platform's own book, never a merchant's",
  );
  expect(
    database.queries.every((query) => query.includes("deleted_at=is.null")),
    "and never reads a row somebody deleted",
  );
}

async function checkAddAndRenew(): Promise<void> {
  const database = createDatabase();

  seedCalendar(database);

  const dependencies = createDependencies(database);
  const added = await addComplianceItem(
    {
      actor: complianceDesk,
      kind: "tax_registration",
      title: "  VAT registration 2026  ",
      issuer: "National Board of Revenue",
      reference: "  ",
      note: "Filed by the compliance desk.",
      issuedOn: dayFromToday(-10),
      expiresOn: dayFromToday(355),
      alertDays: 45,
    },
    dependencies,
  );

  const filed = rowsOf(database, "compliance_items").at(-1);

  expectEqual(filed?.["title"], "VAT registration 2026", "the title is trimmed before it is stored");
  expectEqual(filed?.["reference"], null, "an empty reference is stored as nothing rather than as spaces");
  expectEqual(filed?.["status"], "active", "a filed item starts active");
  expectEqual(filed?.["owner_id"], DESK_ID, "and records the officer who filed it");
  expectEqual(filed?.["alert_days"], 45, "with the window it was given");
  expectEqual(
    database.audits.entries.at(-1)?.action,
    "compliance.item_added",
    "the filing is on the audit trail",
  );
  expectEqual(
    database.audits.entries.at(-1)?.entityId,
    filed?.["id"],
    "against the row it created",
  );
  expectEqual(added.items.length, 5, "and the answer is the calendar with the new row in it");

  expectEqual(
    await failureOf(() =>
      addComplianceItem(
        {
          actor: complianceDesk,
          kind: "passport",
          title: "Passport",
          issuer: "Government",
          reference: null,
          note: null,
          issuedOn: dayFromToday(-10),
          expiresOn: dayFromToday(355),
          alertDays: 30,
        },
        dependencies,
      ),
    ),
    "VALIDATION_FAILED|invalid_format",
    "an unknown kind is refused",
  );
  expectEqual(
    await failureOf(() =>
      addComplianceItem(
        {
          actor: complianceDesk,
          kind: "cyber_insurance",
          title: "   ",
          issuer: "Government",
          reference: null,
          note: null,
          issuedOn: dayFromToday(-10),
          expiresOn: dayFromToday(355),
          alertDays: 30,
        },
        dependencies,
      ),
    ),
    "VALIDATION_FAILED|invalid_length",
    "an item with no title is refused",
  );
  expectEqual(
    await failureOf(() =>
      addComplianceItem(
        {
          actor: complianceDesk,
          kind: "cyber_insurance",
          title: "Policy",
          issuer: "Assurance",
          reference: null,
          note: null,
          issuedOn: dayFromToday(0),
          expiresOn: dayFromToday(0),
          alertDays: 30,
        },
        dependencies,
      ),
    ),
    "VALIDATION_FAILED|not_after_issue",
    "a period that does not move forward is refused",
  );
  expectEqual(
    await failureOf(() =>
      addComplianceItem(
        {
          actor: complianceDesk,
          kind: "cyber_insurance",
          title: "Policy",
          issuer: "Assurance",
          reference: null,
          note: null,
          issuedOn: "2026-02-30",
          expiresOn: dayFromToday(300),
          alertDays: 30,
        },
        dependencies,
      ),
    ),
    "VALIDATION_FAILED|invalid_date",
    "and so is a day that does not exist",
  );
  expectEqual(
    await failureOf(() =>
      addComplianceItem(
        {
          actor: complianceDesk,
          kind: "cyber_insurance",
          title: "Policy",
          issuer: "Assurance",
          reference: null,
          note: null,
          issuedOn: dayFromToday(-10),
          expiresOn: dayFromToday(355),
          alertDays: 3,
        },
        dependencies,
      ),
    ),
    "VALIDATION_FAILED|invalid_range",
    "a warning window closer than a week is refused",
  );
  expectEqual(
    await failureOf(() =>
      addComplianceItem(
        {
          actor: ceo,
          kind: "cyber_insurance",
          title: "Policy",
          issuer: "Assurance",
          reference: null,
          note: null,
          issuedOn: dayFromToday(-10),
          expiresOn: dayFromToday(355),
          alertDays: 30,
        },
        dependencies,
      ),
    ),
    "PERMISSION_DENIED|",
    "the chief executive may not file a certificate",
  );
  expectEqual(
    await failureOf(() =>
      addComplianceItem(
        {
          actor: staleDesk,
          kind: "cyber_insurance",
          title: "Policy",
          issuer: "Assurance",
          reference: null,
          note: null,
          issuedOn: dayFromToday(-10),
          expiresOn: dayFromToday(355),
          alertDays: 30,
        },
        dependencies,
      ),
    ),
    `PERMISSION_DENIED|${REAUTHENTICATION_REQUIRED_RULE}`,
    "and a stale second factor is asked for again before anything is filed",
  );

  // ---- renewing the attestation that is inside its window
  const renewed = await renewComplianceItem(
    {
      actor: complianceDesk,
      itemId: itemIdOf(2),
      issuedOn: null,
      expiresOn: dayFromToday(385),
      reference: "QSA-2027-004",
      note: "Renewed with the assessor of record.",
    },
    dependencies,
  );

  const closed = rowsOf(database, "compliance_items").find((row) => row["id"] === itemIdOf(2));
  const replacement = rowsOf(database, "compliance_items").at(-1);

  expectEqual(closed?.["status"], "renewed", "the old row is closed as renewed");
  expectEqual(closed?.["renewed_at"], NOW_ISO, "with the instant it was replaced");
  expectEqual(closed?.["version"], 2, "and one version further on");
  expectEqual(replacement?.["status"], "active", "while the new period starts active");
  expectEqual(replacement?.["kind"], "pci_attestation", "as the same kind of certificate");
  expectEqual(replacement?.["issued_on"], dayFromToday(20), "a period that begins where the old one ended");
  expectEqual(replacement?.["expires_on"], dayFromToday(385), "and ends on the day it was given");
  expectEqual(replacement?.["reference"], "QSA-2027-004", "with the new reference");
  expectEqual(replacement?.["alert_days"], 30, "and the window the old row had");
  expectEqual(
    database.audits.entries.at(-1)?.action,
    "compliance.item_renewed",
    "the renewal is on the audit trail",
  );
  expectEqual(
    database.audits.entries.at(-1)?.payload?.["replacement_item_id"],
    replacement?.["id"],
    "naming the row it filed",
  );
  expectEqual(renewed.items.length, 6, "and the answer is the calendar with both rows");

  expectEqual(
    await failureOf(() =>
      renewComplianceItem(
        {
          actor: complianceDesk,
          itemId: itemIdOf(2),
          issuedOn: null,
          expiresOn: dayFromToday(700),
          reference: null,
          note: null,
        },
        dependencies,
      ),
    ),
    "CONFLICT|closed",
    "a row that is already renewed cannot be renewed again",
  );
  expectEqual(
    await failureOf(() =>
      renewComplianceItem(
        {
          actor: complianceDesk,
          itemId: "018f2b8a-6666-4c2d-9c3e-999999999999",
          issuedOn: null,
          expiresOn: dayFromToday(400),
          reference: null,
          note: null,
        },
        dependencies,
      ),
    ),
    "RESOURCE_NOT_FOUND|",
    "and an item that is not on the calendar is not found",
  );

  // ---- archiving
  const archived = await archiveComplianceItem({ actor: complianceDesk, itemId: itemIdOf(1) }, dependencies);

  expectEqual(
    rowsOf(database, "compliance_items").find((row) => row["id"] === itemIdOf(1))?.["status"],
    "archived",
    "an archived item is marked, not deleted",
  );
  expect(rowsOf(database, "compliance_items").length > 0, "and the row is still there to answer what covered us");
  expectEqual(
    database.audits.entries.at(-1)?.action,
    "compliance.item_archived",
    "the archiving is on the audit trail",
  );
  expectEqual(archived.items.length, 6, "and the calendar still shows every row");

  expectEqual(
    await failureOf(() => archiveComplianceItem({ actor: complianceDesk, itemId: itemIdOf(1) }, dependencies)),
    "CONFLICT|already_archived",
    "archiving twice is a stale screen, not an action",
  );
  expectEqual(
    await failureOf(() => archiveComplianceItem({ actor: ceo, itemId: itemIdOf(1) }, dependencies)),
    "PERMISSION_DENIED|",
    "and the CEO may not take an item off the calendar",
  );
}

async function checkRun(): Promise<void> {
  const database = createDatabase();

  seedCalendar(database);

  const dependencies = createDependencies(database);
  const first = await runComplianceCalendarCheck({ actor: complianceDesk }, dependencies);

  expectEqual(first.examined, 3, "the check examines what is still active");
  expectEqual(first.expired, 1, "moves the lapsed trade licence to expired");
  expectEqual(first.alerted, 1, "stamps the attestation inside its window");
  expectEqual(first.skipped, 0, "and skips nothing when nobody else is writing");
  expectEqual(first.ranAtEpochMs, NOW, "naming the instant it ran at");
  expectEqual(
    rowsOf(database, "compliance_items")?.find((row) => row["id"] === itemIdOf(3))?.["status"],
    "expired",
    "the lapsed row is expired rather than archived",
  );
  expectEqual(
    rowsOf(database, "compliance_items")?.find((row) => row["id"] === itemIdOf(2))?.["last_alert_at"],
    NOW_ISO,
    "and the warning is stamped on the row",
  );
  expectEqual(
    database.audits.entries.filter((entry) => entry.action === "compliance.alert_sent").length,
    1,
    "one warning, one audit entry",
  );
  expectEqual(
    database.audits.entries.filter((entry) => entry.action === "compliance.item_expired").length,
    1,
    "one expiry, one audit entry",
  );
  expectEqual(
    database.audits.entries.at(-1)?.payload?.["days_remaining"],
    20,
    "and the entry says how far from the expiry the warning was",
  );

  const second = await runComplianceCalendarCheck({ actor: complianceDesk }, dependencies);

  expectEqual(second.expired, 0, "a second run finds nothing more to expire");
  expectEqual(second.alerted, 0, "and nothing more to warn about");
  expectEqual(
    rowsOf(database, "compliance_items")?.find((row) => row["id"] === itemIdOf(2))?.["last_alert_at"],
    NOW_ISO,
    "because the stamp is not moved by a second check",
  );

  // A row a person moved between the read and the write is somebody else's answer.
  const raced = createDatabase();

  seedCalendar(raced);

  raced.beforeUpdate = (table: string, query: string): void => {
    const row = rowsOf(raced, table).find((candidate) => query.includes(`id=eq.${String(candidate["id"])}`));

    if (row !== undefined && row["status"] === "active") {
      row["status"] = "archived";
    }
  };

  const skippedRun = await runComplianceCalendarCheck({ actor: complianceDesk }, createDependencies(raced));

  expectEqual(skippedRun.skipped, 2, "a row moved under the check is counted as skipped");
  expectEqual(skippedRun.expired, 0, "and nothing is claimed to have expired");
  expectEqual(skippedRun.alerted, 0, "nor warned about");

  expectEqual(
    await failureOf(() => runComplianceCalendarCheck({ actor: ceo }, dependencies)),
    "PERMISSION_DENIED|",
    "the chief executive may not run the check",
  );
  expectEqual(
    await failureOf(() => runComplianceCalendarCheck({ actor: staleDesk }, dependencies)),
    `PERMISSION_DENIED|${REAUTHENTICATION_REQUIRED_RULE}`,
    "and a stale second factor may not run it either",
  );
  expectEqual(
    await failureOf(() => runComplianceCalendarCheck({ actor: superAdmin }, dependencies)),
    "no-throw",
    "the super administrator may, because section 2 gives that role full control",
  );
}

/** ---- The source contract: the two routes, the screen and the migration. */
async function checkSources(): Promise<void> {
  const settingsRoute = await readRepositoryFile("app/api/office/settings/route.ts");
  const calendarRoute = await readRepositoryFile("app/api/office/compliance-calendar/route.ts");
  const page = await readRepositoryFile("app/(admin)/settings/page.tsx");
  const form = await readRepositoryFile("app/(admin)/settings/platform-settings-form.tsx");
  const consoleSource = await readRepositoryFile("app/(admin)/settings/compliance-calendar-console.tsx");
  const service = await readRepositoryFile("lib/settings/service.ts");
  const migration = await readRepositoryFile("migrations/0099_compliance_calendar_super_admin.sql");
  const rollback = await readRepositoryFile("migrations/0099_compliance_calendar_super_admin.down.sql");

  const sources: readonly (readonly [string, string])[] = [
    ["app/api/office/settings/route.ts", settingsRoute],
    ["app/api/office/compliance-calendar/route.ts", calendarRoute],
    ["app/(admin)/settings/page.tsx", page],
    ["app/(admin)/settings/platform-settings-form.tsx", form],
    ["app/(admin)/settings/compliance-calendar-console.tsx", consoleSource],
    ["lib/settings/service.ts", service],
  ];

  for (const [path, source] of sources) {
    expectEqual(source.split("\n")[0], `// path: ${path}`, `${path} states its own path on its first line`);
    expectEqual(source.includes("dangerouslySetInnerHTML"), false, `${path} writes no markup from a string`);
    expectEqual(/console\.(log|info|warn|error|debug)\(/u.test(source), false, `${path} logs nothing`);
    expectEqual(source.includes("process.env"), false, `${path} reads no environment variable`);
    expectEqual(/:\s*any\b/u.test(source), false, `${path} writes no any`);
    expectEqual(/https?:\/\//u.test(source), false, `${path} names no absolute URL`);
    expectEqual(/[\u0080-\uFFFF]/u.test(source), false, `${path} is ASCII`);
    // The markers are assembled rather than written out: `config/structure.json` forbids them in any
    // source file, and this gate is one.
    for (const marker of ["TO" + "DO", "FIX" + "ME"]) {
      expectEqual(source.includes(marker), false, `${path} carries no unfinished note`);
    }
  }

  for (const [path, source] of [
    ["app/api/office/settings/route.ts", settingsRoute],
    ["app/api/office/compliance-calendar/route.ts", calendarRoute],
  ] as const) {
    expect(source.includes("requireCsrfToken"), `${path} refuses a request without the double submit token`);
    expect(source.includes("verifySensitiveRequest"), `${path} verifies the device proof`);
    expect(source.includes("requireTrustedDevice"), `${path} refuses an unproven browser`);
    expect(source.includes("readRequestActor"), `${path} reads the session cookie`);
    expect(source.includes("getSettingsRuntime"), `${path} uses the one runtime`);
    expect(source.includes("withErrorResponse"), `${path} answers a refusal in the one shape`);
    expect(source.includes("maximumBodyBytes"), `${path} bounds the body before it parses it`);
    expect(source.includes('"cache-control": "no-store"'), `${path} is never cached`);
  }

  expect(
    CSRF_PROTECTED_PATHS.includes("/api/office/settings"),
    "the settings route is on the CSRF list",
  );
  expect(
    CSRF_PROTECTED_PATHS.includes("/api/office/compliance-calendar"),
    "and so is the calendar route",
  );
  expect(isSensitivePath("/api/office/settings"), "the settings route demands a device proof");
  expect(isSensitivePath("/api/office/compliance-calendar"), "and so does the calendar route");

  expectEqual(
    settingsRoute.split('action !== "save"').length - 1,
    1,
    "the settings route has one action and no verb table",
  );
  expectEqual(
    calendarRoute.split('if (action === "').length - 1,
    4,
    "the calendar route has four actions",
  );
  expect(
    calendarRoute.includes('"add"') &&
      calendarRoute.includes('"renew"') &&
      calendarRoute.includes('"archive"') &&
      calendarRoute.includes('"check"'),
    "which are filing, renewing, archiving and the expiry check",
  );

  expect(page.includes("readOfficeActor"), "the page reads the account through the cached reader");
  expect(page.includes("PLATFORM_INFORMATION_ROLES"), "and asks the settings half's own role list");
  expect(page.includes("COMPLIANCE_CALENDAR_READ_ROLES"), "and the calendar's");
  expect(page.includes("<PlatformSettingsForm"), "the page renders the platform form");
  expect(page.includes("<ComplianceCalendarConsole"), "and the calendar");
  expectEqual(page.includes("super_admin"), false, "naming no role: the registry does");
  expectEqual(page.includes("<main"), false, "the page renders no landmark: the shell owns it");
  expectEqual(page.includes("Date.now()"), false, "and takes no clock of its own");

  expectEqual(form.split("\n")[1], '"use client";', "the form is a client boundary");
  expectEqual(consoleSource.split("\n")[1], '"use client";', "and so is the console");
  expectEqual(
    form.split('method: "POST"').length - 1,
    1,
    "the form has one call site, so one body shape",
  );
  expectEqual(
    consoleSource.split('method: "POST"').length - 1,
    1,
    "the console has one call site for its four actions",
  );
  expect(form.includes("deviceProofHeaders"), "the form signs its request");
  expect(form.includes("csrfHeaders"), "and carries the double submit token");
  expect(consoleSource.includes("deviceProofHeaders"), "the console signs its requests");
  expect(consoleSource.includes("canManage"), "and offers no form the service would refuse");
  expect(form.includes("expectedSavedAtEpochMs") || form.includes("savedAtEpochMs"), "the form names the instant it read");

  expectEqual(
    service.split(".update(").length - 1 > 0,
    true,
    "the service writes through compare-and-set updates",
  );
  expect(service.includes("requireAnyRole"), "the service asks the permission helper");
  expect(service.includes("requireFreshReauthentication"), "and the step up helper");
  expectEqual(
    service.includes('requireAnyRole(input.actor, PLATFORM_INFORMATION_ROLES)'),
    true,
    "with section 24's one role",
  );
  expectEqual(
    /\.delete\(/u.test(service),
    false,
    "and never deletes: a compliance row is history",
  );

  expect(migration.includes("compliance_items_super_admin_all"), "the migration adds the missing policy");
  expect(migration.includes("current_actor_has_role('super_admin')"), "for the super administrator");
  expectEqual(migration.includes("drop policy"), false, "and drops nothing");
  expect(rollback.includes("drop policy if exists"), "the rollback drops the policy it added");
  expectEqual(rollback.includes("delete from"), false, "and loses no row");

  // The catalog must hold every key the two halves reference, placeholders or not.
  const catalog = en.officeSettings as Readonly<Record<string, string>>;
  const referenced = new Set<string>();

  for (const source of [service, page, form, consoleSource]) {
    for (const match of source.matchAll(/officeSettings\.([a-zA-Z0-9_]+)/gu)) {
      referenced.add(match[1] ?? "");
    }
  }

  expect(referenced.size > 20, "the two halves reference the settings block by name");
  expectEqual(
    [...referenced].filter((key) => !(key in catalog)).join(","),
    "",
    "and every key they reference is in the catalog",
  );
}

async function main(): Promise<void> {
  checkRegistry();
  await checkSettingsRead();
  await checkSettingsSave();
  await checkCalendarRead();
  await checkAddAndRenew();
  await checkRun();
  await checkSources();

  if (failures.length > 0) {
    process.stderr.write(`settings gate failed with ${failures.length} problem(s):\n`);

    for (const failure of failures) {
      process.stderr.write(`  - ${failure}\n`);
    }

    process.exitCode = 1;

    return;
  }

  process.stdout.write(
    `settings gate passed: ${checks} checks, ${PLATFORM_INFORMATION_FIELDS.length} setting fields, ` +
      `${COMPLIANCE_ITEM_KINDS.length} kinds, ${SETTINGS_AUDIT_ACTIONS.length} audit names\n`,
  );
}

await main();
