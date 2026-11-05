// path: services/invoices/recurring-schedule-service-verify.ts
import process from "node:process";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { z } from "zod";
import { createInMemoryAuditTrail, type AuditTrail } from "../../lib/auth/audit.ts";
import type { RestClient } from "../../lib/auth/rest.ts";
import type { PlatformRole, RequestActor } from "../../lib/auth/types.ts";
import { AppError, isAppError } from "../../lib/errors/app-error.ts";
import {
  createRecurringSchedule,
  getRecurringSchedule,
  listRecurringSchedules,
  RECURRING_SCHEDULE_CREATED_AUDIT_ACTION,
  RECURRING_SCHEDULE_ENDED_AUDIT_ACTION,
  RECURRING_SCHEDULE_PAUSED_AUDIT_ACTION,
  RECURRING_SCHEDULE_RESUMED_AUDIT_ACTION,
  RECURRING_SCHEDULE_UPDATED_AUDIT_ACTION,
  updateRecurringSchedule,
  setRecurringScheduleState,
} from "./recurring-schedule.ts";
import {
  RECURRING_SCHEDULE_COUNT_LIMITS,
  RECURRING_SCHEDULE_REMINDER_INTERVAL_LIMITS,
  RECURRING_SCHEDULE_REMINDER_LIMIT_LIMITS,
  RECURRING_SCHEDULE_RULES,
  RECURRING_SCHEDULE_TERMS_LIMITS,
} from "./recurring-schedule-fields.ts";

/**
 * The gate for STEP 122 part 2: the schedule service against a database modelled from `0028`.
 *
 * ## How this proves anything without a PostgreSQL
 *
 * The fixture below is the database, and its refusals are transcribed from `0028` rather than from the service:
 * the three column checks that pair a status with its instant, the template guard's three judgements, the
 * reminder pair, the unique partial index on `(company_id, template_invoice_id)` and the two `next_run_on`
 * bounds. A fixture written from the service agrees with the service by construction; one written from the SQL
 * disagrees exactly where the service is wrong.
 *
 * ## The part that is easy to get wrong
 *
 * A service that reads the template and *then* writes is racing every other request, and the only thing that
 * makes one schedule per template true is `recurring_schedules_template_key`. So the fixture models the index,
 * and one group creates two schedules for one template to prove the second arrives as a conflict with a field
 * rather than as a 500 or - worse - as a success.
 */

/* ---- the harness ---- */

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

/** Isolate a group, so a throw is a recorded failure rather than the end of the gate. */
async function group(name: string, body: () => Promise<void>): Promise<void> {
  try {
    await body();
  } catch (error) {
    checks += 1;
    failures.push(`${name} threw instead of recording a failure: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/* ---- actors and fixed facts ---- */

const NOW = Date.parse("2026-11-05T09:00:00.000Z");
const COMPANY_A = "018f2b9c-1111-7000-8000-000000000001";
const COMPANY_B = "018f2b9c-1111-7000-8000-000000000002";
const USER_A = "018f2b9c-2222-7000-8000-000000000001";
const CLIENT_A = "018f2b9c-3333-7000-8000-000000000001";
const CLIENT_B = "018f2b9c-3333-7000-8000-000000000002";
const TEMPLATE_A = "018f2b9c-6666-7000-8000-000000000001";
const TEMPLATE_B = "018f2b9c-6666-7000-8000-000000000002";
const TEMPLATE_ISSUED = "018f2b9c-6666-7000-8000-000000000003";
const TEMPLATE_OTHER = "018f2b9c-6666-7000-8000-000000000004";

function actorOf(roles: readonly PlatformRole[], companyId: string | null, overrides: Partial<RequestActor> = {}): RequestActor {
  return {
    userId: USER_A,
    companyId,
    roles,
    sessionId: "018f2b9c-5555-7000-8000-000000000001",
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
const support = actorOf(["support"], COMPANY_A);

/* ---- the fixture ---- */

interface RecurringDb {
  readonly invoices: Array<Record<string, unknown>>;
  readonly schedules: Array<Record<string, unknown>>;
  readonly queries: string[];
  readonly inserts: Array<{ readonly table: string; readonly rows: readonly Readonly<Record<string, unknown>>[] }>;
  readonly updates: Array<{ readonly table: string; readonly query: string; readonly values: Record<string, unknown> }>;
  /**
   * Set to make every update match no row, which is what PostgREST does when the filters exclude everything:
   * a `204` with nothing written. It is the failure that cannot be seen without a re-read.
   */
  swallowUpdate: boolean;
}

function invoiceRow(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: TEMPLATE_A,
    company_id: COMPANY_A,
    client_id: CLIENT_A,
    number: null,
    status: "draft",
    currency: "USD",
    subtotal_minor: "120000",
    discount_minor: "0",
    tax_minor: "0",
    total_minor: "120000",
    client_name: "Acme Ltd",
    memo: null,
    issued_at: null,
    due_at: new Date(NOW).toISOString(),
    created_at: new Date(NOW).toISOString(),
    updated_at: new Date(NOW).toISOString(),
    deleted_at: null,
    version: 1,
    ...overrides,
  };
}

function createDb(): RecurringDb {
  return {
    invoices: [
      invoiceRow(),
      invoiceRow({ id: TEMPLATE_B, client_id: CLIENT_B, client_name: "Other Co", total_minor: "250000" }),
      invoiceRow({ id: TEMPLATE_ISSUED, status: "sent", number: "INV-2026-0001", issued_at: new Date(NOW).toISOString() }),
      invoiceRow({ id: TEMPLATE_OTHER, company_id: COMPANY_B }),
    ],
    schedules: [],
    queries: [],
    inserts: [],
    updates: [],
    swallowUpdate: false,
  };
}

function queryParts(query: string): Map<string, string> {
  const parts = new Map<string, string>();

  for (const piece of query.split("&")) {
    const index = piece.indexOf("=");

    if (index > 0) {
      parts.set(piece.slice(0, index), decodeURIComponent(piece.slice(index + 1)));
    }
  }

  return parts;
}

function wireOf(row: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const wire: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(row)) {
    wire[key] = typeof value === "bigint" ? value.toString() : value;
  }

  return wire;
}

/**
 * The column checks of `0028`, in the order the constraint list declares them.
 *
 * A schedule row is judged after the triggers, exactly as PostgreSQL does it: `recurring_schedules_guard_template`
 * is BEFORE INSERT OR UPDATE and can raise, and only then are the column checks evaluated.
 */
function scheduleProblem(row: Readonly<Record<string, unknown>>, db: RecurringDb): string | null {
  const status = String(row["status"] ?? "");
  const unit = String(row["interval_unit"] ?? "");
  const count = Number(row["interval_count"] ?? 0);
  const startOn = String(row["start_on"] ?? "");
  const nextRunOn = String(row["next_run_on"] ?? "");
  const endOn = row["end_on"] ?? null;
  const terms = Number(row["terms_days"] ?? 0);
  const reminderInterval = Number(row["reminder_interval_days"] ?? 0);
  const reminderLimit = Number(row["reminder_limit"] ?? 0);
  const pausedAt = row["paused_at"] ?? null;
  const endedAt = row["ended_at"] ?? null;
  const lastRunOn = row["last_run_on"] ?? null;
  const lastReminderOn = row["last_reminder_on"] ?? null;

  if (!["active", "paused", "ended"].includes(status)) {
    return "recurring_schedules_status_check";
  }

  if (!["day", "week", "month", "year"].includes(unit)) {
    return "recurring_schedules_unit_check";
  }

  if (count < 1 || count > 60) {
    return "recurring_schedules_count_check";
  }

  if (nextRunOn < startOn) {
    return "recurring_schedules_next_run_check";
  }

  if (endOn !== null && String(endOn) < startOn) {
    return "recurring_schedules_end_check";
  }

  if (terms < 0 || terms > 365) {
    return "recurring_schedules_terms_check";
  }

  if (reminderInterval < 0 || reminderInterval > 90) {
    return "recurring_schedules_reminder_interval_check";
  }

  if (reminderLimit < 0 || reminderLimit > 10) {
    return "recurring_schedules_reminder_limit_check";
  }

  if ((reminderInterval === 0) !== (reminderLimit === 0)) {
    return "recurring_schedules_reminder_pair_check";
  }

  if ((status === "paused") !== (pausedAt !== null)) {
    return "recurring_schedules_paused_check";
  }

  if ((status === "ended") !== (endedAt !== null)) {
    return "recurring_schedules_ended_check";
  }

  if (lastRunOn !== null && String(lastRunOn) < startOn) {
    return "recurring_schedules_last_run_check";
  }

  if (lastReminderOn !== null && (lastRunOn === null || String(lastReminderOn) < String(lastRunOn))) {
    return "recurring_schedules_last_reminder_check";
  }

  // `recurring_schedules_guard_template`, restated: the template must be this merchant's, still a draft, and
  // for this schedule's client. The service reads these first, so reaching this branch means the service
  // wrote a row the trigger would have raised on - which is the defect this check exists to catch.
  const template = db.invoices.find(
    (candidate) => candidate["id"] === row["template_invoice_id"] && candidate["company_id"] === row["company_id"],
  );

  if (template === undefined) {
    return "recurring_schedules_guard_template";
  }

  if (template["status"] !== "draft") {
    return "recurring_schedules_guard_template";
  }

  if (template["client_id"] !== row["client_id"]) {
    return "recurring_schedules_guard_template";
  }

  return null;
}

function createRest(db: RecurringDb): RestClient {
  return {
    select<TRow>(table: string, query: string, schema: z.ZodType<TRow>): Promise<readonly TRow[]> {
      db.queries.push(`${table}?${query}`);

      const parts = queryParts(query);
      const company = parts.get("company_id");

      if (company === undefined || !company.startsWith("eq.")) {
        return Promise.reject(new Error(`a read is not scoped to one company: ${query}`));
      }

      const rows = table === "recurring_schedules" ? db.schedules : table === "invoices" ? db.invoices : null;

      if (rows === null) {
        return Promise.reject(new Error(`an unmodelled table was read: ${table}`));
      }

      let matched = rows.filter((row) => row["company_id"] === company.slice(3));

      for (const [key, value] of parts) {
        if (key === "select" || key === "order" || key === "limit" || key === "offset") {
          continue;
        }

        if (value === "is.null") {
          matched = matched.filter((row) => (row[key] ?? null) === null);
        } else if (value.startsWith("eq.")) {
          matched = matched.filter((row) => String(row[key] ?? "") === value.slice(3));
        }
      }

      const order = parts.get("order");

      if (order !== undefined && order.startsWith("created_at.desc")) {
        matched = [...matched].reverse();
      }

      const limit = parts.get("limit");

      if (limit !== undefined) {
        matched = matched.slice(0, Number.parseInt(limit, 10));
      }

      const selection = parts.get("select");
      const projected =
        selection === undefined || selection === "*"
          ? matched
          : matched.map((row) => {
              const values: Record<string, unknown> = {};

              for (const column of selection.split(",")) {
                values[column] = row[column] ?? null;
              }

              return values;
            });

      return Promise.resolve(projected.map((row) => schema.parse(wireOf(row))));
    },

    insert(table: string, rows: readonly Readonly<Record<string, unknown>>[]): Promise<void> {
      db.inserts.push({ table, rows });

      return Promise.resolve();
    },

    insertReturning<TRow>(
      table: string,
      rows: readonly Readonly<Record<string, unknown>>[],
      schema: z.ZodType<TRow>,
    ): Promise<readonly TRow[]> {
      db.inserts.push({ table, rows });

      if (table !== "recurring_schedules") {
        return Promise.reject(new Error(`an unmodelled insert was attempted: ${table}`));
      }

      const created: TRow[] = [];

      for (const row of rows) {
        const candidate: Record<string, unknown> = {
          id: randomUUID(),
          status: "active",
          interval_unit: "month",
          interval_count: 1,
          terms_days: 30,
          reminder_interval_days: 0,
          reminder_limit: 0,
          last_run_on: null,
          last_reminder_on: null,
          paused_at: null,
          ended_at: null,
          created_at: new Date(NOW).toISOString(),
          updated_at: new Date(NOW).toISOString(),
          deleted_at: null,
          version: 1,
          ...wireOf(row),
        };

        // `recurring_schedules_template_key`: one live schedule per template inside one merchant. A unique
        // violation is `23505`, which the REST layer reports as CONFLICT and nothing else.
        const taken = db.schedules.some(
          (existing) =>
            existing["deleted_at"] === null &&
            existing["company_id"] === candidate["company_id"] &&
            existing["template_invoice_id"] === candidate["template_invoice_id"],
        );

        if (taken) {
          return Promise.reject(
            new AppError("CONFLICT", { cause: { rule: "recurring_schedule", reason: "23505" } }),
          );
        }

        const problem = scheduleProblem(candidate, db);

        if (problem !== null) {
          // A trigger's `raise exception` is a check_violation, which the REST layer reports as
          // VALIDATION_FAILED - not as a conflict.
          return Promise.reject(new AppError("VALIDATION_FAILED", { cause: { rule: "recurring_schedule", reason: problem } }));
        }

        db.schedules.push(candidate);
        created.push(schema.parse(wireOf(candidate)));
      }

      return Promise.resolve(created);
    },

    update(table: string, query: string, values: Readonly<Record<string, unknown>>): Promise<void> {
      db.updates.push({ table, query, values: { ...values } });

      // PostgREST answers a PATCH that matched nothing with success. The service cannot tell the difference
      // without reading the row back, so the fixture must reproduce the silence rather than an error.
      if (db.swallowUpdate) {
        return Promise.resolve();
      }

      if (table !== "recurring_schedules") {
        return Promise.reject(new Error(`an unmodelled update was attempted: ${table}`));
      }

      const parts = queryParts(query);
      const id = parts.get("id");
      const company = parts.get("company_id");

      if (id === undefined || company === undefined) {
        return Promise.reject(new Error(`an update is not scoped to one row of one company: ${query}`));
      }

      const row = db.schedules.find(
        (candidate) => candidate["id"] === id.slice(3) && candidate["company_id"] === company.slice(3),
      );

      // A PostgREST update that matched nothing still reports success.
      if (row === undefined) {
        return Promise.resolve();
      }

      for (const guard of ["status", "version"] as const) {
        const expected = parts.get(guard);

        if (expected !== undefined && expected.startsWith("eq.") && String(row[guard] ?? "") !== expected.slice(3)) {
          return Promise.resolve();
        }
      }

      // A `RestClient` rethrows what it is given. Wrapping the service's own guard in a plain `Error` would
      // make the service's conflict and validation paths unreachable in this fixture - which is the defect
      // this line exists to prevent.
      const merged: Record<string, unknown> = { ...row, ...wireOf(values) };

      // `recurring_schedules_set_row_metadata`: the clock and the version move, then the checks run.
      merged["updated_at"] = new Date(NOW).toISOString();
      merged["version"] = Number(row["version"]) + 1;

      const problem = scheduleProblem(merged, db);

      if (problem !== null) {
        return Promise.reject(new AppError("VALIDATION_FAILED", { cause: { rule: "recurring_schedule", reason: problem } }));
      }

      for (const [column, value] of Object.entries(merged)) {
        row[column] = value;
      }

      return Promise.resolve();
    },

    rpc(name: string): Promise<unknown> {
      return Promise.reject(new Error(`an unmodelled function was called: ${name}`));
    },
  } as RestClient;
}

function depsOf(db: RecurringDb, audit: AuditTrail = createInMemoryAuditTrail()): {
  readonly rest: RestClient;
  readonly audit: AuditTrail;
  readonly now: () => number;
} {
  return { rest: createRest(db), audit, now: () => NOW };
}

/** A valid create body for the first template. */
function bodyOf(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    template_invoice_id: TEMPLATE_A,
    interval_unit: "month",
    interval_count: "1",
    start_on: "2026-12-01",
    end_on: null,
    terms_days: "30",
    reminder_interval_days: "0",
    reminder_limit: "0",
    ...overrides,
  };
}

/** The failure a call produces, as `code` or `code:field:rule`, so one assertion covers both facts. */
async function refusalOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();

    return "<succeeded>";
  } catch (error) {
    if (!isAppError(error)) {
      return "<not an AppError>";
    }

    const detail = error.details?.[0];

    return detail === undefined ? error.code : `${error.code}:${detail.field}:${detail.rule}`;
  }
}

/* ---- a create ---- */

async function checkCreate(): Promise<void> {
  const db = createDb();
  const audit = createInMemoryAuditTrail();
  const schedule = await createRecurringSchedule({ actor: owner, body: bodyOf() }, depsOf(db, audit));

  expectEqual(schedule.status, "active", "a new schedule is active, which is what `0028` defaults to");
  expectEqual(schedule.intervalUnit, "month", "it keeps the unit that was sent");
  expectEqual(schedule.intervalCount, 1, "and the count");
  expectEqual(schedule.nextRunOn, "2026-12-01", "the first run is the start date the merchant chose");
  expectEqual(schedule.clientId, CLIENT_A, "the client comes from the template, never from the body");
  expectEqual(schedule.templateInvoiceId, TEMPLATE_A, "and it points at the template");
  expectEqual(schedule.version, 1, "a fresh row is version one");

  // The template's face travels with the schedule, so a list needs no second request per row.
  expectEqual(schedule.template.totalMinor, "120000", "the template's total crosses as minor-unit text");
  expectEqual(schedule.template.currency, "USD", "and its currency");

  // One audit entry, and it names the policy rather than the client.
  const entries = audit.entries.filter((entry) => entry.action === RECURRING_SCHEDULE_CREATED_AUDIT_ACTION);
  expectEqual(entries.length, 1, "a create writes exactly one audit entry");

  const payload = JSON.stringify(entries[0]?.payload ?? {});
  expect(payload.includes("interval_unit"), "the trail names the interval it was configured with");
  expect(!payload.includes("Acme"), "and never the client's name");
  expect(!payload.includes("120000"), "and never an amount, because a schedule is configuration and not a bill");

  // Defaults: a body that omits the optional fields still produces a row `0028` accepts.
  const sparse = createDb();
  const minimal = await createRecurringSchedule(
    { actor: owner, body: { template_invoice_id: TEMPLATE_B, start_on: "2026-12-05" } },
    depsOf(sparse),
  );
  expectEqual(minimal.intervalUnit, "month", "an omitted unit is a month");
  expectEqual(minimal.intervalCount, 1, "an omitted count is one");
  expectEqual(minimal.termsDays, 30, "an omitted term is thirty days");
  expectEqual(minimal.reminderIntervalDays, 0, "and reminders are off");
  expectEqual(minimal.reminderLimit, 0, "with a limit of zero, because the pair has one off-switch");
  expectEqual(minimal.endOn, null, "and there is no last run until one is asked for");
}

/* ---- the refusals ---- */

async function checkRefusals(): Promise<void> {
  // A template that is not a draft is refused against the field the merchant chose, not by the trigger.
  const issued = createDb();
  expectEqual(
    await refusalOf(() =>
      createRecurringSchedule({ actor: owner, body: bodyOf({ template_invoice_id: TEMPLATE_ISSUED }) }, depsOf(issued)),
    ),
    "VALIDATION_FAILED:template_invoice_id:not_draft",
    "a sent invoice cannot be a template",
  );
  expectEqual(issued.schedules.length, 0, "and nothing is written");

  // Another merchant's invoice is not found - the answer does not say whether it exists.
  const foreign = createDb();
  expectEqual(
    await refusalOf(() =>
      createRecurringSchedule({ actor: owner, body: bodyOf({ template_invoice_id: TEMPLATE_OTHER }) }, depsOf(foreign)),
    ),
    "VALIDATION_FAILED:template_invoice_id:not_found",
    "another merchant's invoice is not found",
  );

  // The bounds are `0028`'s, and each is reported against its own field.
  for (const [field, value, rule] of [
    ["interval_count", String(RECURRING_SCHEDULE_COUNT_LIMITS.max + 1), "too_large"],
    ["interval_count", String(RECURRING_SCHEDULE_COUNT_LIMITS.min - 1), "too_small"],
    ["terms_days", String(RECURRING_SCHEDULE_TERMS_LIMITS.max + 1), "too_large"],
    ["reminder_interval_days", String(RECURRING_SCHEDULE_REMINDER_INTERVAL_LIMITS.max + 1), "too_large"],
    ["reminder_limit", String(RECURRING_SCHEDULE_REMINDER_LIMIT_LIMITS.max + 1), "too_large"],
  ] as const) {
    const db = createDb();

    expectEqual(
      await refusalOf(() => createRecurringSchedule({ actor: owner, body: bodyOf({ [field]: value }) }, depsOf(db))),
      `VALIDATION_FAILED:${field}:${rule}`,
      `${field} of ${value} is refused as ${rule}`,
    );
  }

  // A date that is not a date, and an end before the start.
  expectEqual(
    await refusalOf(() => createRecurringSchedule({ actor: owner, body: bodyOf({ start_on: "2026-02-30" }) }, depsOf(createDb()))),
    "VALIDATION_FAILED:start_on:invalid_format",
    "the 30th of February is not a start date",
  );
  expectEqual(
    await refusalOf(() =>
      createRecurringSchedule({ actor: owner, body: bodyOf({ start_on: "2026-12-01", end_on: "2026-11-01" }) }, depsOf(createDb())),
    ),
    "VALIDATION_FAILED:end_on:too_small",
    "an end before the start is refused",
  );
  expectEqual(
    await refusalOf(() =>
      createRecurringSchedule({ actor: owner, body: bodyOf({ start_on: "2026-13-01" }) }, depsOf(createDb())),
    ),
    "VALIDATION_FAILED:start_on:invalid_format",
    "a thirteenth month is not a date either",
  );

  // `recurring_schedules_reminder_pair_check`: zero days with a limit, or a limit of zero with days.
  expectEqual(
    await refusalOf(() =>
      createRecurringSchedule({ actor: owner, body: bodyOf({ reminder_interval_days: "0", reminder_limit: "3" }) }, depsOf(createDb())),
    ),
    "VALIDATION_FAILED:reminder_limit:invalid_format",
    "a limit with no interval is refused",
  );
  expectEqual(
    await refusalOf(() =>
      createRecurringSchedule({ actor: owner, body: bodyOf({ reminder_interval_days: "7", reminder_limit: "0" }) }, depsOf(createDb())),
    ),
    "VALIDATION_FAILED:reminder_limit:too_small",
    "and an interval with no limit",
  );
  expectEqual(
    await refusalOf(() =>
      createRecurringSchedule({ actor: owner, body: bodyOf({ interval_unit: "quarter" }) }, depsOf(createDb())),
    ),
    "VALIDATION_FAILED:interval_unit:invalid_format",
    "a unit `0028` does not allow is refused",
  );
  expectEqual(
    await refusalOf(() =>
      createRecurringSchedule({ actor: owner, body: bodyOf({ reminder_interval: "7" }) }, depsOf(createDb())),
    ),
    "VALIDATION_FAILED:reminder_interval:unknown_field",
    "an unknown key is reported rather than dropped, so a misspelt reminder is not silently lost",
  );

  // A caller who cannot write an invoice cannot configure a schedule.
  expectEqual(
    await refusalOf(() => createRecurringSchedule({ actor: support, body: bodyOf() }, depsOf(createDb()))),
    "PERMISSION_DENIED",
    "a role that cannot write an invoice cannot configure its schedule",
  );

  // Every rule the service can emit is one the vocabulary names.
  const emitted = new Set<string>();

  for (const body of [
    bodyOf({ template_invoice_id: TEMPLATE_ISSUED }),
    bodyOf({ start_on: "2026-02-30" }),
    bodyOf({ interval_count: "0" }),
    bodyOf({ start_on: "2026-12-01", end_on: "2026-11-01" }),
    bodyOf({ interval_unit: "quarter" }),
    bodyOf({ reminder_interval: "7" }),
  ]) {
    try {
      await createRecurringSchedule({ actor: owner, body }, depsOf(createDb()));
    } catch (error) {
      if (isAppError(error)) {
        for (const detail of error.details ?? []) {
          emitted.add(detail.rule);
        }
      }
    }
  }

  for (const rule of emitted) {
    expect((RECURRING_SCHEDULE_RULES as readonly string[]).includes(rule), `"${rule}" is a rule this family names`);
  }
}

/* ---- one template, one schedule ---- */

async function checkTemplateUniqueness(): Promise<void> {
  const db = createDb();
  await createRecurringSchedule({ actor: owner, body: bodyOf() }, depsOf(db));

  // `recurring_schedules_template_key` is the only thing that makes this true. The service's own read of the
  // template cannot, because two requests can both pass it before either writes.
  expectEqual(
    await refusalOf(() => createRecurringSchedule({ actor: owner, body: bodyOf() }, depsOf(db))),
    "CONFLICT:template_invoice_id:already_used",
    "a template that already drives a schedule answers as a conflict against the template",
  );
  expectEqual(db.schedules.length, 1, "and the second create writes nothing");

  // A different template is a different schedule, and a different merchant is a different book.
  const other = await createRecurringSchedule(
    { actor: owner, body: bodyOf({ template_invoice_id: TEMPLATE_B }) },
    depsOf(db),
  );
  expectEqual(other.templateInvoiceId, TEMPLATE_B, "a second template gets its own schedule");
  expectEqual(other.clientId, CLIENT_B, "billed to that template's client");
}

/* ---- reads ---- */

async function checkReads(): Promise<void> {
  const db = createDb();
  const created = await createRecurringSchedule({ actor: owner, body: bodyOf() }, depsOf(db));

  const read = await getRecurringSchedule({ actor: owner, scheduleId: created.id }, depsOf(db));
  expectEqual(read.id, created.id, "a schedule can be read back by id");
  expectEqual(read.nextRunOn, "2026-12-01", "with the next run it was created with");

  expectEqual(
    await refusalOf(() => getRecurringSchedule({ actor: owner, scheduleId: randomUUID() }, depsOf(db))),
    "RESOURCE_NOT_FOUND",
    "an id that is not a schedule is not found",
  );
  expectEqual(
    await refusalOf(() => getRecurringSchedule({ actor: owner, scheduleId: "not-a-uuid" }, depsOf(db))),
    "VALIDATION_FAILED:id:invalid_format",
    "and a malformed id is a field problem",
  );

  // The list is the merchant's own, bounded, and says when there is more.
  const listed = await listRecurringSchedules({ actor: owner }, { rest: createRest(db) });
  expectEqual(listed.schedules.length, 1, "the list holds the schedule that was created");
  expectEqual(listed.truncated, false, "and is not truncated when it fits");

  for (let index = 0; index < 55; index += 1) {
    db.schedules.push({
      ...db.schedules[0],
      id: randomUUID(),
      template_invoice_id: randomUUID(),
      created_at: new Date(NOW + index * 1_000).toISOString(),
    });
  }

  const many = await listRecurringSchedules({ actor: owner }, { rest: createRest(db) });
  expectEqual(many.schedules.length, 50, "a merchant with more than fifty schedules gets fifty");
  expectEqual(many.truncated, true, "and is told the list continues");

  // Every read is scoped to one company and names its columns: rule 17, enforced by the fixture too.
  expect(
    db.queries.every((query) => query.includes("company_id=eq.")),
    "no read crosses a tenant boundary",
  );
  expect(
    db.queries.filter((query) => query.startsWith("recurring_schedules?")).every((query) => query.includes("select=")),
    "every schedule read names its columns rather than asking for a star",
  );
}

/* ---- an edit ---- */

async function checkUpdate(): Promise<void> {
  const db = createDb();
  const created = await createRecurringSchedule({ actor: owner, body: bodyOf() }, depsOf(db));

  // A policy edit moves the interval and the next run with it, and asks the engine rather than computing.
  const edited = await updateRecurringSchedule(
    { actor: owner, scheduleId: created.id, body: { interval_count: "2", version: 1 } },
    depsOf(db),
  );
  expectEqual(edited.intervalCount, 2, "the count moves");
  expectEqual(
    edited.nextRunOn,
    "2026-12-01",
    "and the next run is still the first one, because a schedule that has never run keeps the date it was given",
  );
  expectEqual(edited.version, 2, "and the row's version moves once");

  // A stale version is a conflict, not a silent overwrite - the race `0028`'s version column exists for.
  expectEqual(
    await refusalOf(() =>
      updateRecurringSchedule({ actor: owner, scheduleId: created.id, body: { interval_count: "3", version: 1 } }, depsOf(db)),
    ),
    "CONFLICT:version:already_changed",
    "a body carrying an old version is refused as a conflict",
  );
  expectEqual(db.schedules[0]?.["interval_count"], 2, "and the newer value survives");

  // `0028`'s own bounds apply to an edit exactly as they do to a create.
  expectEqual(
    await refusalOf(() =>
      updateRecurringSchedule({ actor: owner, scheduleId: created.id, body: { terms_days: "366", version: 2 } }, depsOf(db)),
    ),
    "VALIDATION_FAILED:terms_days:too_large",
    "an edit cannot exceed a bound the column declares",
  );

  // The template and the next run are not editable: neither is in the schema, and both are refused as unknown.
  expectEqual(
    await refusalOf(() =>
      updateRecurringSchedule({ actor: owner, scheduleId: created.id, body: { template_invoice_id: TEMPLATE_B, version: 2 } }, depsOf(db)),
    ),
    "VALIDATION_FAILED:template_invoice_id:unknown_field",
    "a schedule's template cannot be re-pointed",
  );
  expectEqual(
    await refusalOf(() =>
      updateRecurringSchedule({ actor: owner, scheduleId: created.id, body: { next_run_on: "2027-01-01", version: 2 } }, depsOf(db)),
    ),
    "VALIDATION_FAILED:next_run_on:unknown_field",
    "and its next run is the engine's answer, not a typed field",
  );

  // An update names the fields it actually moved, so the trail says what changed rather than what the row holds.
  const audit = createInMemoryAuditTrail();
  await updateRecurringSchedule(
    { actor: owner, scheduleId: created.id, body: { terms_days: "45", version: 2 } },
    depsOf(db, audit),
  );

  const entry = audit.entries.find((candidate) => candidate.action === RECURRING_SCHEDULE_UPDATED_AUDIT_ACTION);
  expect(entry !== undefined, "an edit writes its own audit entry");
  expectEqual(
    JSON.stringify(entry?.payload?.["fields"]),
    JSON.stringify(["terms_days"]),
    "and names only the field that moved",
  );
}

/* ---- pause, resume, end ---- */

async function checkStates(): Promise<void> {
  const db = createDb();
  const created = await createRecurringSchedule({ actor: owner, body: bodyOf() }, depsOf(db));

  // Pausing writes the status and its instant together, because `0028` pairs them.
  const paused = await setRecurringScheduleState(
    { actor: owner, scheduleId: created.id, action: "pause", version: 1 },
    depsOf(db),
  );
  expectEqual(paused.status, "paused", "a schedule can be paused");
  expect(paused.pausedAtEpochMs !== null, "and the pause is dated");
  expectEqual(paused.version, 2, "and the row moves once");

  // A paused schedule is not edited: its interval has no meaning while it is not running.
  expectEqual(
    await refusalOf(() =>
      updateRecurringSchedule({ actor: owner, scheduleId: created.id, body: { interval_count: "3", version: 2 } }, depsOf(db)),
    ),
    "VALIDATION_FAILED:status:invalid_format",
    "a paused schedule's policy is not editable",
  );

  const resumed = await setRecurringScheduleState(
    { actor: owner, scheduleId: created.id, action: "resume", version: 2 },
    depsOf(db),
  );
  expectEqual(resumed.status, "active", "a paused schedule can be resumed");
  expectEqual(resumed.pausedAtEpochMs, null, "and its pause instant is cleared, because the check pairs status and time");

  const ended = await setRecurringScheduleState(
    { actor: owner, scheduleId: created.id, action: "end", version: 3 },
    depsOf(db),
  );
  expectEqual(ended.status, "ended", "and it can be ended");
  expect(ended.endedAtEpochMs !== null, "with the end dated");

  // Ending is final: an ended schedule is history, not a paused one.
  expectEqual(
    await refusalOf(() => setRecurringScheduleState({ actor: owner, scheduleId: created.id, action: "resume", version: 4 }, depsOf(db))),
    "VALIDATION_FAILED:status:already_ended",
    "an ended schedule cannot be resumed",
  );
  expectEqual(
    await refusalOf(() => setRecurringScheduleState({ actor: owner, scheduleId: created.id, action: "end", version: 4 }, depsOf(db))),
    "VALIDATION_FAILED:status:already_ended",
    "nor ended a second time",
  );

  // Every transition writes its own audit action, so the trail distinguishes three verbs.
  const audit = createInMemoryAuditTrail();
  const second = await createRecurringSchedule({ actor: owner, body: bodyOf({ template_invoice_id: TEMPLATE_B }) }, depsOf(db, audit));
  await setRecurringScheduleState({ actor: owner, scheduleId: second.id, action: "pause", version: 1 }, depsOf(db, audit));

  for (const action of [
    RECURRING_SCHEDULE_PAUSED_AUDIT_ACTION,
    RECURRING_SCHEDULE_RESUMED_AUDIT_ACTION,
    RECURRING_SCHEDULE_ENDED_AUDIT_ACTION,
  ]) {
    expect(/^recurring_schedule[.][a-z_]+$/u.test(action), `${action} is a shape ` + "`0013` accepts");
  }

  expect(
    audit.entries.some((entry) => entry.action === RECURRING_SCHEDULE_PAUSED_AUDIT_ACTION),
    "a pause is recorded as a pause",
  );
}

/* ---- lost writes ---- */

async function checkLostWrite(): Promise<void> {
  const db = createDb();
  const created = await createRecurringSchedule({ actor: owner, body: bodyOf() }, depsOf(db));

  // A PostgREST update that matched nothing still reports success. The service must notice, or the screen
  // shows a policy the database never stored.
  db.swallowUpdate = true;

  expectEqual(
    await refusalOf(() =>
      updateRecurringSchedule({ actor: owner, scheduleId: created.id, body: { interval_count: "4", version: 1 } }, depsOf(db)),
    ),
    "CONFLICT:version:already_changed",
    "an update the database did not apply is reported as a conflict rather than as a save",
  );

  expectEqual(
    await refusalOf(() =>
      setRecurringScheduleState({ actor: owner, scheduleId: created.id, action: "pause", version: 1 }, depsOf(db)),
    ),
    "CONFLICT:version:already_changed",
    "and so is a state change that did not land",
  );
}

/* ---- the routes and the screen ---- */

async function checkRoutesAndScreen(): Promise<void> {
  const listRoute = await readRepositoryFile("app/api/invoices/recurring/route.ts");
  const itemRoute = await readRepositoryFile("app/api/invoices/recurring/[id]/route.ts");
  const stateRoute = await readRepositoryFile("app/api/invoices/recurring/[id]/state/route.ts");
  const csrf = await readRepositoryFile("lib/security/csrf.ts");
  const page = await readRepositoryFile("app/(dashboard)/invoices/recurring/page.tsx");
  const panel = await readRepositoryFile("app/(dashboard)/invoices/recurring-schedule-panel.tsx");

  // Each mutating route takes the CSRF token before it reads the body, and the read route does not.
  for (const [name, source] of [
    ["the list route", listRoute],
    ["the state route", stateRoute],
  ] as const) {
    expect(source.includes("requireCsrfToken("), `${name} refuses a request without the CSRF token`);
  }

  expect(
    itemRoute.includes('export const PATCH') && itemRoute.includes("requireCsrfToken("),
    "the item route guards its PATCH, which is the only verb it writes with",
  );
  expect(
    itemRoute.indexOf("requireCsrfToken(") < itemRoute.indexOf("await request.text()"),
    "and checks the token before it reads the body",
  );

  // A GET must not be on the protected list, and every POST must be.
  expect(csrf.includes('"/api/invoices/recurring"'), "the create path is CSRF protected");
  expect(csrf.includes('"/api/invoices/recurring/[id]/state"'), "and the state path");
  expect(
    !csrf.includes('"/api/invoices/recurring/[id]",'),
    "the item path is not, because its PATCH carries no form submission a browser can be tricked into",
  );

  // Every route names the service rather than touching a table.
  for (const [name, source] of [
    ["the list route", listRoute],
    ["the item route", itemRoute],
    ["the state route", stateRoute],
  ] as const) {
    expect(
      source.includes("@/services/invoices/recurring-schedule"),
      `${name} goes through the service rather than writing a table`,
    );
    expect(source.includes("no-store"), `${name} keeps a merchant's billing configuration out of a cache`);
    expect(source.includes("withErrorResponse"), `${name} answers refusals in the house envelope`);
  }

  // The screen reads on the server and offers drafts only, because `0028` refuses any other template.
  expect(page.includes("InvoiceRecurringScreen"), "the page renders the server component");
  expect(page.includes('export const dynamic = "force-dynamic"'), "and is read per request, because a next run moves");

  // The panel is a client component that never imports a value from a server module.
  expect(panel.startsWith("// path: app/(dashboard)/invoices/recurring-schedule-panel.tsx\n"), "the panel starts with its path");
  expect(panel.includes('"use client"'), "and is a client component");
  expect(
    !/from "@\/services\/invoices\/recurring-schedule"/u.test(panel),
    "which imports no value from the server-only service",
  );
  expect(panel.includes("csrfHeaders()"), "so it asks for the CSRF token at submit time");
  expect(panel.includes("/api/invoices/recurring/"), "and talks to the routes rather than to a table");
}

/* ---- the migration's own guarantees ---- */

async function checkMigration(): Promise<void> {
  const migration = await readRepositoryFile("migrations/0028_recurring_schedules.sql");

  // The two guards that make a schedule's history readable, which this service relies on rather than restates.
  expect(
    migration.includes("recurring_schedules_paused_check check (\n    (status = 'paused') = (paused_at is not null)\n  )"),
    "`0028` pairs a pause with its instant, which is why the service writes both in one statement",
  );
  expect(
    migration.includes("recurring_schedules_ended_check check ((status = 'ended') = (ended_at is not null))"),
    "and an end with its instant",
  );
  expect(
    migration.includes("create unique index recurring_schedules_template_key"),
    "one live schedule per template is the database's answer, not a read that could be stale",
  );
  expect(
    migration.includes("template_state is distinct from 'draft'"),
    "and the template guard is why a create reads the invoice's status first",
  );
  expect(
    migration.includes("the schedule client must be the template client"),
    "which is also why the client comes from the template rather than from the body",
  );
}

/* ---- the run ---- */

async function run(): Promise<void> {
  await group("create", checkCreate);
  await group("refusals", checkRefusals);
  await group("template uniqueness", checkTemplateUniqueness);
  await group("reads", checkReads);
  await group("update", checkUpdate);
  await group("states", checkStates);
  await group("lost write", checkLostWrite);
  await group("routes and screen", checkRoutesAndScreen);
  await group("migration", checkMigration);

  if (failures.length > 0) {
    process.stderr.write(`recurring schedule service gate failed with ${String(failures.length)} problem(s):\n`);

    for (const failure of failures) {
      process.stderr.write(`  - ${failure}\n`);
    }

    process.exitCode = 1;

    return;
  }

  process.stdout.write(
    `recurring schedule service gate passed: ${String(checks)} checks, a schedule created from a draft template ` +
      "with the client taken from it, every bound of 0028 reported against its own field, one live schedule per " +
      "template enforced by the index, an edit that moves the next run through the engine, three audited state " +
      "transitions, a lost write reported as a conflict, and three routes that go through the service\n",
  );
}

await run();
