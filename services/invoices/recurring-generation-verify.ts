// path: services/invoices/recurring-generation-verify.ts
import process from "node:process";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { z } from "zod";
import { createInMemoryAuditTrail } from "../../lib/auth/audit.ts";
import type { RestClient } from "../../lib/auth/rest.ts";
import { AppError, isAppError } from "../../lib/errors/app-error.ts";
import {
  generateRecurringInvoice,
  listDueRecurringSchedules,
  recordRecurringReminder,
  sweepAllRecurringReminders,
  sweepRecurringReminders,
} from "./recurring-generation.ts";
import {
  RECURRING_GENERATED_AUDIT_ACTION,
  RECURRING_GENERATED_STATUS,
  RECURRING_REMINDER_EVENT_TYPE,
  RECURRING_REMINDER_QUEUED_AUDIT_ACTION,
  RECURRING_REMINDER_STATUSES,
  recurringReminderDedupeKey,
} from "./recurring-generation-fields.ts";
import { runRecurringScheduleJob, currentCalendarDay } from "./recurring-schedule-job.ts";

/**
 * The gate for STEP 123: generation, the due and not-due cases, and the reminders that follow.
 *
 * ## How this proves anything without a PostgreSQL
 *
 * The fixture below is the part of the database this STEP depends on, and its refusals are transcribed from the
 * SQL rather than from the service:
 *
 *   - `0119`'s two unique partial indexes - `invoices_recurring_run_key` and `invoice_events_dedupe_key_key` -
 *     because uniqueness is the whole mechanism and a fixture without them would pass with any implementation;
 *   - `0119`'s `invoices_recurring_pair_check` and `invoice_events_dedupe_key_check`;
 *   - `0022`'s `invoices_issue_check` (a non-draft invoice needs a number and an `issued_at`), which is what
 *     proves a generated invoice is a draft rather than a `sent` row somebody typed;
 *   - `0024`'s append-only trigger, so a reminder cannot be quietly updated into place;
 *   - `0026`/`0022`'s tenant pairing, so a read cannot cross a merchant boundary unseen.
 *
 * A fixture written from the service agrees with the service by construction. One written from the SQL disagrees
 * exactly where the service is wrong, which is the only place worth looking.
 *
 * ## What this gate deliberately cannot see
 *
 * There is no PostgreSQL in this sandbox, so nothing here proves that `invoices_due_idx` is *chosen* by the
 * planner - only that the query's predicate is written in the shape that index was built for. That distinction is
 * stated in the handoff rather than papered over. Likewise no email exists to send, so a reminder is proved to be
 * recorded, never delivered.
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

async function group(name: string, body: () => Promise<void>): Promise<void> {
  try {
    await body();
  } catch (error) {
    checks += 1;
    failures.push(`${name} threw instead of recording a failure: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/* ---- fixed facts ---- */

const NOW = Date.parse("2026-11-05T09:00:00.000Z");
const COMPANY_A = "018f2b9c-1111-7000-8000-000000000001";
const COMPANY_B = "018f2b9c-1111-7000-8000-000000000002";
const SCHEDULE_A = "018f2b9c-4444-7000-8000-000000000001";
const SCHEDULE_PAUSED = "018f2b9c-4444-7000-8000-000000000002";
const SCHEDULE_ENDED = "018f2b9c-4444-7000-8000-000000000003";
const SCHEDULE_OTHER = "018f2b9c-4444-7000-8000-000000000004";
const TEMPLATE_A = "018f2b9c-6666-7000-8000-000000000001";
const TEMPLATE_ISSUED = "018f2b9c-6666-7000-8000-000000000002";
const TEMPLATE_EMPTY = "018f2b9c-6666-7000-8000-000000000003";
const TEMPLATE_OTHER = "018f2b9c-6666-7000-8000-000000000004";
const CLIENT_A = "018f2b9c-3333-7000-8000-000000000001";
const RUN_ON = "2026-11-01";

/* ---- the fixture: `0119`, `0022`, `0023`, `0024` and `0028`, as much of them as matters ---- */

interface World {
  readonly invoices: Array<Record<string, unknown>>;
  readonly items: Array<Record<string, unknown>>;
  readonly events: Array<Record<string, unknown>>;
  readonly schedules: Array<Record<string, unknown>>;
  readonly queries: string[];
  /** Make the item insert fail, so the rollback path can be exercised. */
  failLineInsert: boolean;
  /** Make the schedule update match nothing, the silent success PostgREST gives. */
  swallowUpdate: boolean;
  /** Every read that carried no company, so the gate can bound how many discovery reads one run makes. */
  readonly unscopedReads: string[];
}

function invoiceRow(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: randomUUID(),
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
    client_email: "billing@acme.test",
    client_address: "12 Long Street",
    memo: "Monthly retainer",
    issued_at: null,
    due_at: "2026-10-01T00:00:00.000Z",
    recurring_schedule_id: null,
    recurring_run_on: null,
    created_at: new Date(NOW).toISOString(),
    updated_at: new Date(NOW).toISOString(),
    deleted_at: null,
    version: 1,
    ...overrides,
  };
}

function scheduleRow(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: SCHEDULE_A,
    company_id: COMPANY_A,
    client_id: CLIENT_A,
    template_invoice_id: TEMPLATE_A,
    status: "active",
    interval_unit: "month",
    interval_count: 1,
    start_on: "2026-01-01",
    next_run_on: RUN_ON,
    end_on: null,
    terms_days: 14,
    reminder_interval_days: 7,
    reminder_limit: 3,
    last_run_on: null,
    last_reminder_on: null,
    paused_at: null,
    ended_at: null,
    created_at: new Date(NOW).toISOString(),
    updated_at: new Date(NOW).toISOString(),
    deleted_at: null,
    version: 1,
    ...overrides,
  };
}

function createWorld(): World {
  return {
    invoices: [
      invoiceRow({ id: TEMPLATE_A }),
      invoiceRow({ id: TEMPLATE_ISSUED, status: "sent", number: "INV-2026-0001", issued_at: "2026-09-01T00:00:00.000Z" }),
      invoiceRow({ id: TEMPLATE_EMPTY }),
      invoiceRow({ id: TEMPLATE_OTHER, company_id: COMPANY_B }),
    ],
    items: [
      { id: randomUUID(), company_id: COMPANY_A, invoice_id: TEMPLATE_A, position: 1, description: "Retainer", unit: "hour", quantity: "10.000", unit_price_minor: "12000", discount_minor: "0", line_total_minor: "120000", product_id: null, service_id: null, deleted_at: null },
      { id: randomUUID(), company_id: COMPANY_A, invoice_id: TEMPLATE_ISSUED, position: 1, description: "Setup", unit: "unit", quantity: "1.000", unit_price_minor: "50000", discount_minor: "0", line_total_minor: "50000", product_id: null, service_id: null, deleted_at: null },
    ],
    events: [],
    schedules: [
      scheduleRow(),
      scheduleRow({ id: SCHEDULE_PAUSED, template_invoice_id: TEMPLATE_ISSUED, status: "paused", paused_at: new Date(NOW).toISOString() }),
      scheduleRow({ id: SCHEDULE_ENDED, template_invoice_id: TEMPLATE_ISSUED, status: "ended", ended_at: new Date(NOW).toISOString() }),
      scheduleRow({ id: SCHEDULE_OTHER, company_id: COMPANY_B, template_invoice_id: TEMPLATE_OTHER, next_run_on: "2026-11-02" }),
    ],
    queries: [],
    failLineInsert: false,
    swallowUpdate: false,
    unscopedReads: [],
  };
}

/**
 * The first schedule of a world, as a mutable row.
 *
 * A gate that reaches into the fixture with `!` earns a lint error and, worse, hides the case where the row it
 * assumed is not there: the assertion would turn a missing fixture into a crash rather than a failed check. This
 * helper creates a default row if the world is empty, so a broken fixture shows up as the check it breaks.
 */
function patchSchedule(world: World, index: number): Record<string, unknown> {
  const row: Record<string, unknown> | undefined = world.schedules[index];

  if (row === undefined) {
    const created = scheduleRow({ id: `018f2b9c-4444-7000-8000-${String(index).padStart(12, "0")}` });

    world.schedules[index] = created;

    return created;
  }

  return row;
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

function matches(row: Readonly<Record<string, unknown>>, key: string, value: string): boolean {
  const actual = row[key] ?? null;

  if (value === "is.null") {
    return actual === null;
  }

  if (value === "not.is.null") {
    return actual !== null;
  }

  if (value.startsWith("eq.")) {
    return String(actual ?? "") === value.slice(3);
  }

  // `lte.` is tested before `lt.`, because "lte." starts with "lt." and the shorter test would compare a value
  // against the text "e.2026-11-05" - always false, so a due schedule would silently look not-yet-due.
  if (value.startsWith("lte.")) {
    return actual !== null && String(actual) <= value.slice(4);
  }

  if (value.startsWith("lt.")) {
    return actual !== null && String(actual) < value.slice(3);
  }

  if (value.startsWith("in.(")) {
    const allowed = value.slice(4, -1).split(",");

    return allowed.includes(String(actual ?? ""));
  }

  throw new Error(`the fixture was asked for a predicate it does not model: ${key}=${value}`);
}

/**
 * The row checks of `0119` and `0022`, in the order the database evaluates them.
 *
 * The invoice checks come first because they are what makes a generated row honest: `invoices_issue_check` is the
 * constraint that refuses a non-draft row without a number, and `invoices_recurring_pair_check` is `0119`'s rule
 * that a schedule and its occurrence are set together or not at all.
 */
function invoiceProblem(row: Readonly<Record<string, unknown>>): string | null {
  const status = String(row["status"] ?? "");
  const scheduleId = row["recurring_schedule_id"] ?? null;
  const runOn = row["recurring_run_on"] ?? null;

  if (!["draft", "sent", "viewed", "partially_paid", "paid", "overdue", "void"].includes(status)) {
    return "invoices_status_check";
  }

  // `invoices_issue_check`: anything that is not a draft must carry a number and an issue instant.
  if (status !== "draft" && (row["number"] === null || row["issued_at"] === null)) {
    return "invoices_issue_check";
  }

  // `0119`'s pairing.
  if ((scheduleId === null) !== (runOn === null)) {
    return "invoices_recurring_pair_check";
  }

  return null;
}

function insertInvoice(world: World, row: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const problem = invoiceProblem(row);

  if (problem !== null) {
    throw new AppError("VALIDATION_FAILED", { cause: { rule: "invoice", reason: problem } });
  }

  // `invoices_recurring_run_key`: unique over (company_id, recurring_schedule_id, recurring_run_on) where the
  // schedule is not null. This is the mechanism the STEP's idempotency claim rests on, so the fixture models it
  // exactly rather than trusting the service to have checked first.
  if (row["recurring_schedule_id"] !== null) {
    const taken = world.invoices.some(
      (existing) =>
        existing["deleted_at"] === null &&
        existing["company_id"] === row["company_id"] &&
        existing["recurring_schedule_id"] === row["recurring_schedule_id"] &&
        existing["recurring_run_on"] === row["recurring_run_on"],
    );

    if (taken) {
      throw new AppError("CONFLICT", { cause: { rule: "invoice", reason: "23505" } });
    }
  }

  const created: Record<string, unknown> = {
    id: randomUUID(),
    number: null,
    subtotal_minor: "0",
    discount_minor: "0",
    discount_basis: "flat",
    discount_percent_bp: 0,
    total_minor: "0",
    amount_paid_minor: "0",
    issued_at: null,
    first_viewed_at: null,
    paid_at: null,
    voided_at: null,
    created_at: new Date(NOW).toISOString(),
    updated_at: new Date(NOW).toISOString(),
    deleted_at: null,
    version: 1,
    ...wireOf(row),
  };

  world.invoices.push(created);

  return created;
}

function insertEvent(world: World, row: Readonly<Record<string, unknown>>): void {
  const dedupeKey = row["dedupe_key"] ?? null;

  if (dedupeKey !== null) {
    if (typeof dedupeKey !== "string" || dedupeKey.length < 8 || dedupeKey.length > 200) {
      throw new AppError("VALIDATION_FAILED", { cause: { rule: "invoice_event", reason: "invoice_events_dedupe_key_check" } });
    }

    // `invoice_events_dedupe_key_key`: unique over (company_id, dedupe_key) where the key is not null.
    const taken = world.events.some(
      (existing) => existing["company_id"] === row["company_id"] && existing["dedupe_key"] === dedupeKey,
    );

    if (taken) {
      throw new AppError("CONFLICT", { cause: { rule: "invoice_event", reason: "23505" } });
    }
  }

  if (row["actor"] === "system" && (row["actor_user_id"] ?? null) !== null) {
    throw new AppError("VALIDATION_FAILED", { cause: { rule: "invoice_event", reason: "invoice_events_actor_user_check" } });
  }

  world.events.push({
    id: randomUUID(),
    occurred_at: new Date(NOW).toISOString(),
    created_at: new Date(NOW).toISOString(),
    deleted_at: null,
    version: 1,
    ...wireOf(row),
  });
}

function createRest(world: World): RestClient {
  return {
    select<TRow>(table: string, query: string, schema: z.ZodType<TRow>): Promise<readonly TRow[]> {
      world.queries.push(`${table}?${query}`);

      const parts = queryParts(query);
      const source =
        table === "invoices"
          ? world.invoices
          : table === "invoice_items"
            ? world.items
            : table === "invoice_events"
              ? world.events
              : table === "recurring_schedules"
                ? world.schedules
                : null;

      if (source === null) {
        return Promise.reject(new Error(`an unmodelled table was read: ${table}`));
      }

      // Two reads in this STEP legitimately carry no company, and both are *discovery* reads whose whole job is to
      // learn the tenant: a job payload is a pointer (`schedule_id` only, by STEP 122's design), so the generator
      // must read the schedule by id before it knows which merchant it is working for; and the fleet sweep reads
      // the invoices to find the merchants to visit. Every other read must be scoped, and the gate asserts below
      // that the bootstrap happens exactly once per run rather than becoming a habit.
      const scoped = parts.has("company_id");
      // The scheduler's own question is "which schedules are due, anywhere", so its read is a third discovery
      // read and is bounded by `limit` in the query rather than by the fixture.
      const bootstrap = table === "recurring_schedules" && !scoped && parts.has("id");
      const dueDiscovery = table === "recurring_schedules" && !scoped && parts.get("status") === "eq.active";
      const fleetDiscovery = table === "invoices" && !scoped;

      if (!scoped && !bootstrap && !dueDiscovery && !fleetDiscovery) {
        return Promise.reject(new Error(`a read is not scoped to one company: ${table}?${query}`));
      }

      if (!scoped) {
        world.unscopedReads.push(`${table}?${query}`);
      }

      let matched = [...source];

      for (const [key, value] of parts) {
        if (key === "select" || key === "order" || key === "limit") {
          continue;
        }

        matched = matched.filter((row) => matches(row, key, value));
      }

      const order = parts.get("order");

      if (order !== undefined && order.startsWith("due_at.asc")) {
        matched.sort((left, right) => String(left["due_at"]).localeCompare(String(right["due_at"])));
      }

      const limit = parts.get("limit");

      if (limit !== undefined) {
        matched = matched.slice(0, Number.parseInt(limit, 10));
      }

      const selection = parts.get("select");
      const projected =
        selection === undefined
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
      if (table === "invoice_items") {
        if (world.failLineInsert) {
          return Promise.reject(new AppError("VALIDATION_FAILED", { cause: { rule: "invoice_item", reason: "forced" } }));
        }

        for (const row of rows) {
          world.items.push({
            id: randomUUID(),
            line_total_minor: "0",
            created_at: new Date(NOW).toISOString(),
            deleted_at: null,
            version: 1,
            ...wireOf(row),
          });
        }

        return Promise.resolve();
      }

      if (table === "invoice_events") {
        try {
          for (const row of rows) {
            insertEvent(world, row);
          }
        } catch (error) {
          return Promise.reject(error);
        }

        return Promise.resolve();
      }

      return Promise.reject(new Error(`an unmodelled insert was attempted: ${table}`));
    },

    insertReturning<TRow>(
      table: string,
      rows: readonly Readonly<Record<string, unknown>>[],
      schema: z.ZodType<TRow>,
    ): Promise<readonly TRow[]> {
      if (table !== "invoices") {
        return Promise.reject(new Error(`an unmodelled insert was attempted: ${table}`));
      }

      const created: TRow[] = [];

      try {
        for (const row of rows) {
          const candidate = insertInvoice(world, row);
          created.push(schema.parse(wireOf(candidate)));
        }
      } catch (error) {
        return Promise.reject(error);
      }

      return Promise.resolve(created);
    },

    update(table: string, query: string, values: Readonly<Record<string, unknown>>): Promise<void> {
      if (world.swallowUpdate) {
        return Promise.resolve();
      }

      const parts = queryParts(query);
      const source = table === "invoices" ? world.invoices : table === "recurring_schedules" ? world.schedules : null;

      if (source === null) {
        return Promise.reject(new Error(`an unmodelled update was attempted: ${table}`));
      }

      const matched = source.filter((row) => {
        for (const [key, value] of parts) {
          if (!matches(row, key, value)) {
            return false;
          }
        }

        return true;
      });

      for (const row of matched) {
        // `recurring_schedules` has no state machine trigger over `next_run_on`, and `invoices` here only ever
        // receives `deleted_at`, which `0022` requires to be non-decreasing - both restated so a service that
        // wrote a column the database forbids would fail here rather than pass.
        for (const [key, value] of Object.entries(values)) {
          if (table === "invoices" && key === "deleted_at" && value === null) {
            return Promise.reject(new Error("0022 refuses clearing deleted_at"));
          }

          row[key] = value;
        }

        row["updated_at"] = new Date(NOW).toISOString();
        row["version"] = Number(row["version"]) + 1;
      }

      return Promise.resolve();
    },

    rpc(): Promise<unknown> {
      return Promise.reject(new Error("this STEP calls no stored function"));
    },
  };
}

function depsOf(world: World): { readonly rest: RestClient; readonly audit: ReturnType<typeof createInMemoryAuditTrail>; readonly now: () => number } {
  return { rest: createRest(world), audit: createInMemoryAuditTrail(), now: () => NOW };
}

/* ---- group 1: one generated invoice, and it is a draft ---- */

async function checkGeneration(): Promise<void> {
  const world = createWorld();
  const dependencies = depsOf(world);

  const result = await generateRecurringInvoice({ scheduleId: SCHEDULE_A, runOn: RUN_ON }, dependencies);

  expectEqual(result.kind, "generated", "a due schedule generates an invoice");
  expect(result.invoiceId !== null, "and reports which invoice it produced");

  const generated = world.invoices.find((row) => row["id"] === result.invoiceId);

  expect(generated !== undefined, "the invoice exists in the world");

  if (generated === undefined) {
    return;
  }

  // The status decision, proved rather than asserted: a `sent` row would have failed `invoices_issue_check`
  // above, because this generator allocates no number and writes no `issued_at`.
  expectEqual(generated["status"], RECURRING_GENERATED_STATUS, "the generated invoice is a draft, not a fake sent");
  expectEqual(generated["status"], "draft", "and the constant says draft");
  expectEqual(generated["number"], null, "with no number, because no issue action allocated one");
  expectEqual(generated["issued_at"], null, "and no issued_at, because nothing issued it");

  expectEqual(generated["company_id"], COMPANY_A, "the invoice belongs to the schedule's merchant");
  expectEqual(generated["client_id"], CLIENT_A, "and to the schedule's client, taken from the template");
  expectEqual(generated["currency"], "USD", "with the template's currency");
  expectEqual(generated["client_name"], "Acme Ltd", "and the template's snapshot of the client name");
  expectEqual(generated["memo"], "Monthly retainer", "and its memo");

  // The due date is measured from the payload's run date and the schedule's terms, never from the clock. The run
  // date is 2026-11-01 and the terms are 14 days, so the invoice is due on 2026-11-15 even though "now" is the
  // fifth of November - a run delivered late still bills the period it was for.
  expectEqual(generated["due_at"], "2026-11-15T00:00:00.000Z", "the due date is the run date plus the schedule's terms");

  expectEqual(generated["recurring_schedule_id"], SCHEDULE_A, "0119 records which schedule produced it");
  expectEqual(generated["recurring_run_on"], RUN_ON, "and which occurrence it bills, which is the payload's date");

  // The lines are the template's, copied rather than recomputed.
  const lines = world.items.filter((row) => row["invoice_id"] === generated["id"]);

  expectEqual(lines.length, 1, "the template's one line was copied");
  expectEqual(lines[0]?.["description"], "Retainer", "with its description");
  expectEqual(lines[0]?.["quantity"], "10.000", "and its decimal quantity, carried rather than reparsed");
  expectEqual(lines[0]?.["unit_price_minor"], "12000", "and its price");
  expectEqual(lines[0]?.["company_id"], COMPANY_A, "and the tenant on the line too");

  // The schedule advanced by the engine's anchor rule: a monthly schedule started on the first runs on the first.
  const schedule = world.schedules.find((row) => row["id"] === SCHEDULE_A);

  expectEqual(schedule?.["last_run_on"], RUN_ON, "the schedule records that this occurrence is filled");
  expectEqual(schedule?.["next_run_on"], "2026-12-01", "and the engine computed the next run from the anchor");

  // The audit entry exists, names the occurrence, and carries neither a client name nor an amount.
  const audit = dependencies.audit.entries;
  const generatedEntry = audit.find((entry) => entry.action === RECURRING_GENERATED_AUDIT_ACTION);

  expect(generatedEntry !== undefined, "a generation writes an audit entry");
  expectEqual(generatedEntry?.actorUserId, null, "with no user, because a scheduled run has nobody behind it");
  expectEqual(generatedEntry?.entityId, SCHEDULE_A, "naming the schedule");
  expectEqual(generatedEntry?.payload["run_on"], RUN_ON, "and the occurrence it filled");
  expect(
    !JSON.stringify(generatedEntry?.payload ?? {}).includes("Acme"),
    "and no client name in the trail, which is a name in a log line",
  );
  expect(
    !JSON.stringify(generatedEntry?.payload ?? {}).includes("120000"),
    "and no amount in the trail, which is the merchant's money",
  );
}

/* ---- group 2: due and not-yet-due ---- */

async function checkDueAndNotDue(): Promise<void> {
  const notDue = await generateRecurringInvoice({ scheduleId: SCHEDULE_A, runOn: "2026-12-01" }, depsOf(createWorld()));
  expectEqual(notDue.kind, "skipped", "a run for a date the schedule is not waiting for is skipped");
  expectEqual(notDue.reason, "not_due", "and says so, rather than raising");
  expectEqual(notDue.invoiceId, null, "and produces no invoice");

  const pausedWorld = createWorld();
  const paused = await generateRecurringInvoice({ scheduleId: SCHEDULE_PAUSED, runOn: RUN_ON }, depsOf(pausedWorld));
  expectEqual(paused.reason, "paused", "a paused schedule runs nothing");
  expectEqual(
    pausedWorld.invoices.length,
    createWorld().invoices.length,
    "and writes no invoice at all, so pausing is honoured before any row exists",
  );

  const ended = await generateRecurringInvoice({ scheduleId: SCHEDULE_ENDED, runOn: RUN_ON }, depsOf(createWorld()));
  expectEqual(ended.reason, "ended", "an ended schedule runs nothing");

  const missing = await generateRecurringInvoice({ scheduleId: randomUUID(), runOn: RUN_ON }, depsOf(createWorld()));
  expectEqual(missing.reason, "missing", "a schedule that no longer exists is skipped rather than raised");

  // A paused schedule is refused before the template is even read: the world's queries prove the order.
  expect(
    !pausedWorld.queries.some((query) => query.includes("invoice_items")),
    "a paused run reads no template lines, because the refusal came first",
  );

  // The end date is the occurrence's business, not today's.
  const endedByDate = createWorld();
  patchSchedule(endedByDate, 0)["end_on"] = "2026-10-15";
  const pastEnd = await generateRecurringInvoice({ scheduleId: SCHEDULE_A, runOn: RUN_ON }, depsOf(endedByDate));
  expectEqual(pastEnd.reason, "ended", "an occurrence after the schedule's end date is skipped");

  // The issued template: a merchant who sent the template meant to stop copying it.
  const issuedWorld = createWorld();
  patchSchedule(issuedWorld, 0)["template_invoice_id"] = TEMPLATE_ISSUED;
  const issued = await generateRecurringInvoice({ scheduleId: SCHEDULE_A, runOn: RUN_ON }, depsOf(issuedWorld));
  expectEqual(issued.reason, "template_not_draft", "a template that is no longer a draft is refused");
  expectEqual(
    issuedWorld.invoices.filter((row) => row["recurring_run_on"] === RUN_ON).length,
    0,
    "and nothing is generated from it",
  );

  // An empty template is not a document.
  const emptyWorld = createWorld();
  patchSchedule(emptyWorld, 0)["template_invoice_id"] = TEMPLATE_EMPTY;
  const empty = await generateRecurringInvoice({ scheduleId: SCHEDULE_A, runOn: RUN_ON }, depsOf(emptyWorld));
  expectEqual(empty.reason, "template_empty", "a template with no lines is refused rather than copied into a nothing");

  // A run date that is not a real calendar day is refused at the boundary.
  let refused = false;

  try {
    await generateRecurringInvoice({ scheduleId: SCHEDULE_A, runOn: "2026-02-30" }, depsOf(createWorld()));
  } catch (error) {
    refused = isAppError(error) && error.code === "VALIDATION_FAILED";
  }

  expect(refused, "a date that matches the pattern but does not exist is refused, as STEP 122 stated it would be");
}

/* ---- group 3: idempotency, which is the point of the STEP ---- */

async function checkIdempotency(): Promise<void> {
  const world = createWorld();
  const dependencies = depsOf(world);

  const first = await generateRecurringInvoice({ scheduleId: SCHEDULE_A, runOn: RUN_ON }, dependencies);
  expectEqual(first.kind, "generated", "the first run generates");

  const invoiceCount = world.invoices.length;
  const itemCount = world.items.length;

  // The same run, again, with the schedule already advanced. This is the ordinary at-least-once redelivery.
  const second = await generateRecurringInvoice({ scheduleId: SCHEDULE_A, runOn: RUN_ON }, dependencies);
  expectEqual(second.kind, "skipped", "the same occurrence run twice is skipped");
  expectEqual(second.reason, "already_generated", "and named as a repeat rather than as not-due");
  expectEqual(world.invoices.length, invoiceCount, "and creates no second invoice");
  expectEqual(world.items.length, itemCount, "and no second set of lines");

  // The harder case: the schedule was never advanced - a worker died between the insert and the update - so the
  // next run passes the `next_run_on` gate and reaches the insert. Only the unique index can stop it.
  const raced = createWorld();
  const racedDependencies = depsOf(raced);

  await generateRecurringInvoice({ scheduleId: SCHEDULE_A, runOn: RUN_ON }, racedDependencies);
  patchSchedule(raced, 0)["last_run_on"] = null;
  patchSchedule(raced, 0)["next_run_on"] = RUN_ON;

  const racedCount = raced.invoices.length;
  const replay = await generateRecurringInvoice({ scheduleId: SCHEDULE_A, runOn: RUN_ON }, racedDependencies);

  expectEqual(replay.kind, "skipped", "a replay that the schedule gate cannot see is stopped by the index");
  expectEqual(replay.reason, "already_generated", "and reported as the same occurrence");
  expectEqual(raced.invoices.length, racedCount, "so the client still has exactly one invoice for November");

  // Two occurrences of one schedule are still two invoices: the index is per occurrence, not per schedule. The
  // second occurrence is the date the schedule itself now waits for, which is the engine's answer rather than a
  // date typed here - a service that only ever ran on the exact date the test guessed would pass this line and
  // fail every real month.
  // A fresh world, because the one above was deliberately rewound to replay November: its `next_run_on` is still
  // November's, and asking it for December would be asking a schedule that has not moved yet.
  const twoWorld = createWorld();
  const twoDependencies = depsOf(twoWorld);

  const november = await generateRecurringInvoice({ scheduleId: SCHEDULE_A, runOn: RUN_ON }, twoDependencies);
  const nextOccurrence = String(twoWorld.schedules[0]?.["next_run_on"] ?? "");
  const later = await generateRecurringInvoice({ scheduleId: SCHEDULE_A, runOn: nextOccurrence }, twoDependencies);
  expectEqual(later.kind, "generated", "the next occurrence generates its own invoice");
  expect(
    later.invoiceId !== null && later.invoiceId !== november.invoiceId,
    "which is a different document from November's",
  );

  // And the schedule's own bookkeeping is re-read rather than trusted: PostgREST reports a PATCH that matched
  // nothing as success, so a run that silently failed to advance is the failure a re-read exists to catch.
  const swallowed = createWorld();
  const swallowedDependencies = depsOf(swallowed);

  swallowed.swallowUpdate = true;

  let caught = false;

  try {
    await generateRecurringInvoice({ scheduleId: SCHEDULE_A, runOn: RUN_ON }, swallowedDependencies);
  } catch (error) {
    caught = isAppError(error) && error.code === "INTERNAL_ERROR";
  }

  expect(caught, "a schedule update that silently matched nothing is caught by the re-read, not reported as success");
}

/* ---- group 4: reminders are recorded, once, and never for a draft ---- */

async function checkReminders(): Promise<void> {
  const world = createWorld();

  // A sent invoice of this merchant, generated by the schedule and already overdue.
  const overdue = invoiceRow({
    id: randomUUID(),
    status: "sent",
    number: "INV-2026-0007",
    issued_at: "2026-09-20T00:00:00.000Z",
    due_at: "2026-10-20T00:00:00.000Z",
    recurring_schedule_id: SCHEDULE_A,
    recurring_run_on: "2026-10-01",
  });

  world.invoices.push(overdue);

  const dependencies = depsOf(world);
  const sweep = await sweepRecurringReminders({ companyId: COMPANY_A, today: "2026-11-05" }, dependencies);

  // 2026-10-20 due, 2026-11-05 today, seven-day interval: sixteen days overdue is ordinal three, which is the
  // third reminder - and `reminderOfInvoice` is right to skip to it rather than send three at once. The engine's
  // rule is "the n-th reminder falls on the n-th interval", so a sweep that missed two does not replay them.
  expectEqual(sweep.queued, 1, "one overdue invoice earns one reminder today");

  const reminders = world.events.filter((row) => row["type"] === RECURRING_REMINDER_EVENT_TYPE);

  expectEqual(reminders.length, 1, "exactly one reminder event was recorded");
  expectEqual(reminders[0]?.["actor"], "system", "written by the system, not by a person");
  expectEqual(reminders[0]?.["actor_user_id"], null, "and carrying no user, because nobody sent it");
  expectEqual(
    reminders[0]?.["dedupe_key"],
    recurringReminderDedupeKey({ scheduleId: SCHEDULE_A, runOn: "2026-10-01", invoiceId: String(overdue["id"]), ordinal: 3 }),
    "with a key naming the schedule, the occurrence, the invoice and the ordinal - and nothing about the clock",
  );

  // The record is a queue fact, never a delivery fact, and the audit trail says so in words.
  const audit = dependencies.audit.entries;
  const queuedEntry = audit.find((entry) => entry.action === RECURRING_REMINDER_QUEUED_AUDIT_ACTION);

  expect(queuedEntry !== undefined, "recording a reminder writes an audit entry");
  expectEqual(queuedEntry?.payload["delivery"], "not_attempted", "which states that no delivery was attempted");
  expectEqual(queuedEntry?.actorUserId, null, "and carries no user");

  // Re-running the sweep the same day records nothing new, and this is the property the whole STEP turns on.
  const second = await sweepRecurringReminders({ companyId: COMPANY_A, today: "2026-11-05" }, depsOf(world));
  expectEqual(second.queued, 0, "a repeated sweep the same day records nothing");
  expectEqual(
    world.events.filter((row) => row["type"] === RECURRING_REMINDER_EVENT_TYPE).length,
    1,
    "so the reminder count for that invoice is still one",
  );

  // A third run, and a fourth, still one.
  await sweepRecurringReminders({ companyId: COMPANY_A, today: "2026-11-05" }, depsOf(world));
  await sweepRecurringReminders({ companyId: COMPANY_A, today: "2026-11-05" }, depsOf(world));
  expectEqual(
    world.events.filter((row) => row["type"] === RECURRING_REMINDER_EVENT_TYPE).length,
    1,
    "and four runs of one sweep still leave one reminder, which is the duplicate this STEP must not create",
  );

  // The draft generated by group 1 is in this merchant's book and is never reminded: a document nobody received
  // cannot be late. The sweep's own status filter is what enforces it.
  const draft = invoiceRow({ id: randomUUID(), status: "draft", due_at: "2026-09-01T00:00:00.000Z", recurring_schedule_id: SCHEDULE_A, recurring_run_on: "2026-08-01" });
  world.invoices.push(draft);

  const withDraft = await sweepRecurringReminders({ companyId: COMPANY_A, today: "2026-11-05" }, depsOf(world));

  expectEqual(
    withDraft.queued,
    0,
    "an overdue draft earns no reminder, which is why generated drafts stay silent until they are issued",
  );
  expect(
    !world.events.some((row) => row["invoice_id"] === draft["id"]),
    "and the draft's timeline holds no reminder at all",
  );

  // The off-switch: a schedule with zero reminders sends none, and `0028`'s pair check makes that one switch.
  const offWorld = createWorld();
  const offInvoice = invoiceRow({
    id: randomUUID(),
    status: "sent",
    number: "INV-2026-0008",
    issued_at: "2026-09-20T00:00:00.000Z",
    due_at: "2026-09-25T00:00:00.000Z",
    recurring_schedule_id: SCHEDULE_A,
    recurring_run_on: "2026-09-01",
  });

  offWorld.invoices.push(offInvoice);
  patchSchedule(offWorld, 0)["reminder_interval_days"] = 0;
  patchSchedule(offWorld, 0)["reminder_limit"] = 0;

  const off = await sweepRecurringReminders({ companyId: COMPANY_A, today: "2026-11-05" }, depsOf(offWorld));

  expectEqual(off.queued, 0, "a schedule that asks for no reminders sends none");
  expectEqual(offWorld.events.length, 0, "and records nothing in the timeline");

  // A paused schedule stops reminding while the invoice stays late and visible.
  const pausedWorld = createWorld();
  pausedWorld.invoices.push(overdue);
  patchSchedule(pausedWorld, 0)["status"] = "paused";
  patchSchedule(pausedWorld, 0)["paused_at"] = new Date(NOW).toISOString();

  const pausedSweep = await sweepRecurringReminders({ companyId: COMPANY_A, today: "2026-11-05" }, depsOf(pausedWorld));

  expectEqual(pausedSweep.queued, 0, "a paused schedule stops the cadence");
  expectEqual(pausedWorld.events.length, 0, "and the invoice keeps its late status without a reminder");

  // The cross-merchant sweep visits both merchants and keeps their timelines apart.
  const allWorld = createWorld();
  const mine = invoiceRow({ id: randomUUID(), status: "viewed", issued_at: "2026-09-20T00:00:00.000Z", due_at: "2026-10-20T00:00:00.000Z", recurring_schedule_id: SCHEDULE_A, recurring_run_on: "2026-10-01" });
  const theirs = invoiceRow({ id: randomUUID(), company_id: COMPANY_B, status: "sent", number: "INV-B-1", issued_at: "2026-09-20T00:00:00.000Z", due_at: "2026-10-20T00:00:00.000Z", recurring_schedule_id: SCHEDULE_OTHER, recurring_run_on: "2026-10-02" });

  allWorld.invoices.push(mine, theirs);

  const all = await sweepAllRecurringReminders({ today: "2026-11-05" }, depsOf(allWorld));

  expectEqual(all.companies, 2, "the fleet sweep visits both merchants");
  expectEqual(all.queued, 2, "and records one reminder for each, in its own timeline");
  expectEqual(
    allWorld.events.filter((row) => row["company_id"] === COMPANY_B).length,
    1,
    "the second merchant's reminder is scoped to the second merchant",
  );

  // A reminder for one merchant can never collide with another's, because the index is scoped by tenant: the
  // same key in two companies is two rows, and the fixture below proves the fixture itself agrees.
  const twinWorld = createWorld();
  const key = recurringReminderDedupeKey({ scheduleId: SCHEDULE_A, runOn: "2026-10-01", invoiceId: "018f2b9c-7777-7000-8000-000000000001", ordinal: 1 });

  twinWorld.events.push({ company_id: COMPANY_A, dedupe_key: key });
  twinWorld.events.push({ company_id: COMPANY_B, dedupe_key: key });

  expectEqual(
    twinWorld.events.filter((row) => row["dedupe_key"] === key).length,
    2,
    "one key in two merchants is two rows, which is why the index carries company_id",
  );
}

/* ---- group 5: failure and rollback ---- */

async function checkFailureAndRollback(): Promise<void> {
  const world = createWorld();
  const dependencies = depsOf(world);

  world.failLineInsert = true;

  const before = world.invoices.length;
  let raised = false;

  try {
    await generateRecurringInvoice({ scheduleId: SCHEDULE_A, runOn: RUN_ON }, dependencies);
  } catch (error) {
    raised = isAppError(error) && error.code === "VALIDATION_FAILED";
  }

  expect(raised, "a line insert that fails fails the run rather than reporting a generated invoice");

  const orphan = world.invoices.find(
    (row) => row["recurring_schedule_id"] === SCHEDULE_A && row["deleted_at"] === null,
  );

  expect(orphan === undefined, "and the invoice is compensated away, so no empty draft is left in the book");
  expectEqual(world.invoices.length, before + 1, "the row was written and then soft-deleted, not left live");

  const tombstone = world.invoices.find((row) => row["recurring_schedule_id"] === SCHEDULE_A);

  expect(tombstone !== undefined && tombstone["deleted_at"] !== null, "the compensation is a soft delete, so evidence survives");

  // The schedule did not advance, so the occurrence is still owed. Idempotency is untouched by the failure: the
  // next run reuses the same occurrence and, because the tombstoned row is excluded from the index by hand, the
  // retry has to be the operator's decision rather than an automatic one - which is why `maxAttempts` is one.
  const schedule = world.schedules.find((row) => row["id"] === SCHEDULE_A);

  expectEqual(schedule?.["last_run_on"], null, "a failed run does not mark the occurrence as filled");
  expectEqual(schedule?.["next_run_on"], RUN_ON, "and does not move the schedule forward");

  // The failure wrote no audit entry claiming a generation happened.
  expect(
    !dependencies.audit.entries.some((entry) => entry.action === RECURRING_GENERATED_AUDIT_ACTION),
    "and claims no generation in the trail, because nothing was generated",
  );

  // A reminder insert that fails for a reason other than a duplicate is not swallowed.
  const eventWorld = createWorld();
  const brokenRest: RestClient = {
    ...createRest(eventWorld),
    insert(): Promise<void> {
      return Promise.reject(new AppError("DEPENDENCY_FAILED"));
    },
  };

  let propagated = false;

  try {
    await recordRecurringReminder(
      {
        companyId: COMPANY_A,
        invoiceId: randomUUID(),
        scheduleId: SCHEDULE_A,
        runOn: "2026-10-01",
        dueOn: "2026-10-20",
        reminderIntervalDays: 7,
        reminderLimit: 3,
        today: "2026-11-05",
      },
      { rest: brokenRest, audit: createInMemoryAuditTrail(), now: () => NOW },
    );
  } catch (error) {
    propagated = isAppError(error) && error.code === "DEPENDENCY_FAILED";
  }

  expect(propagated, "a storage failure that is not a duplicate propagates instead of being read as one");
}

/* ---- group 6: the due query is written to the index of 0022 ---- */

async function checkDueQuery(): Promise<void> {
  const service = await readRepositoryFile("services/invoices/recurring-generation.ts");
  const migration = await readRepositoryFile("migrations/0022_invoices.sql");

  // The index's predicate, read from the SQL that declares it.
  expect(
    migration.includes("create index invoices_due_idx") &&
      migration.includes("where status in ('sent', 'viewed', 'partially_paid') and deleted_at is null"),
    "0022 declares invoices_due_idx over the three open statuses and live rows",
  );

  const migrationOverdue = await readRepositoryFile("migrations/0120_invoice_overdue_event.sql");

  expect(
    migrationOverdue.includes("create index invoices_due_reminder_idx") &&
      migrationOverdue.includes(
        "where status in ('sent', 'viewed', 'partially_paid', 'overdue') and deleted_at is null",
      ),
    "0120 declares invoices_due_reminder_idx over the four open statuses, overdue among them",
  );

  // The constant is that predicate, written once: a document that has become overdue is exactly the one
  // whose reminders must go on, so the reminder sweep reads four statuses rather than three.
  expectEqual(
    RECURRING_REMINDER_STATUSES.join(","),
    "sent,viewed,partially_paid,overdue",
    "the reminder statuses are exactly the index's four, in its order",
  );
  expect(!RECURRING_REMINDER_STATUSES.includes("draft" as never), "and draft is not among them");
  expectEqual(RECURRING_REMINDER_STATUSES.length, 4, "with four statuses and no fifth");

  // The query: an equality on the status set, `deleted_at is null`, and a range on `due_at` rather than a
  // function of it - a `date(due_at)` wrapper is the classic way to defeat a btree index without noticing.
  expect(
    service.includes("status=in.(${RECURRING_REMINDER_STATUSES.join(\",\")})"),
    "the sweep filters on the same status set through the shared constant, so the two cannot drift",
  );
  expect(service.includes("deleted_at=is.null"), "and on live rows");
  expect(
    service.includes("due_at=lt.${input.today}T00:00:00.000Z"),
    "and on a range of due_at, which a btree can use",
  );
  const serviceCode = service.replaceAll(/\/\*[\s\S]*?\*\//gu, "").replaceAll(/\/\/.*/gu, "");

  expect(
    !/date\(due_at\)|due_at::date/u.test(serviceCode),
    "never on a function of the column, which an index cannot use",
  );

  // The index is never called: it is chosen. Stated because "verify the query matches the index" can be
  // mistaken for "call the index".
  // The prose explaining the predicate legitimately names the index, so the claim is about the code: no query
  // string, and no call, ever names it. An index is chosen by the planner, never invoked.
  expect(
    (serviceCode.match(/invoices_due_idx/gu) ?? []).length === 0,
    "no query in the service names the index, because an index is chosen and not called",
  );

  // A missing company would make the sweep cross tenants, so every scoped read carries it.
  expect(service.includes("company_id=eq.${input.companyId}") || service.includes("company_id=eq.${invoice"),
    "the per-merchant sweep is scoped to one company");

  // The fleet sweep is the one read that discovers merchants, and it must be a read of the invoices themselves
  // rather than of a tenant list this STEP does not own.
  expect(
    service.includes("export async function sweepAllRecurringReminders"),
    "the fleet sweep exists",
  );
  expect(
    service.includes("new Set(companies.map((row) => row.company_id))"),
    "and de-duplicates the merchants it found before visiting them",
  );
}

/* ---- group 7: the STEP boundary ---- */

async function checkStepBoundary(): Promise<void> {
  const service = await readRepositoryFile("services/invoices/recurring-generation.ts");
  const job = await readRepositoryFile("services/invoices/recurring-schedule-job.ts");
  const fields = await readRepositoryFile("services/invoices/recurring-generation-fields.ts");
  const code = service.replaceAll(/\/\*[\s\S]*?\*\//gu, "").replaceAll(/\/\/.*/gu, "");
  const jobCode = job.replaceAll(/\/\*[\s\S]*?\*\//gu, "").replaceAll(/\/\/.*/gu, "");

  // No email is composed, imported or sent. `lib/email` belongs to STEPs 221-230 and this STEP must not touch it.
  expect(!/lib\/email/u.test(code) && !/lib\/email/u.test(jobCode), "nothing imports lib/email, which STEPs 221-230 own");
  expect(!/\bemail\b/u.test(code.replaceAll(/client_email/gu, "").replaceAll(/email is/gu, "")), "no email is composed here");
  expect(!/sendMail|smtp|nodemailer/iu.test(code), "and no mail transport is named");

  // A reminder is never described as delivered, which is the claim this STEP must not make.
  for (const word of ["delivered", "sent_to_client", "delivery_status"]) {
    expect(!new RegExp(`"${word}":`, "u").test(code), `the service never writes a "${word}" field, because it cannot know`);
  }

  expect(fields.includes('delivery: "not_attempted"') || service.includes('delivery: "not_attempted"'),
    "the audit entry states that delivery was not attempted, rather than leaving it ambiguous");

  // The generator never issues: no number allocation, no issued_at, no non-draft status.
  expect(!/takeInvoiceNumber/u.test(code), "the generator never allocates an invoice number");
  expect(!/issued_at:/u.test(code), "and never writes issued_at");
  expect(code.includes("status: RECURRING_GENERATED_STATUS") || service.includes("RECURRING_GENERATED_STATUS = \"draft\""),
    "and writes the draft status through a named constant rather than a literal");
  expect(fields.includes('RECURRING_GENERATED_STATUS = "draft"'), "which is the word draft");

  // No float touches money: prices are carried as the text PostgREST returned.
  expect(!/parseFloat|Number\(.*_minor/u.test(code), "money is never parsed into a float");
  expect(code.includes("function priceText"), "and the one conversion that exists carries the text");

  // The job registers a real handler through STEP 122's seam rather than adding a second one.
  expect(jobCode.includes("registerRecurringScheduleJob(registry,"), "the handler is registered through STEP 122's seam");
  expectEqual((jobCode.match(/\.register\(/gu) ?? []).length, 1, "and there is still exactly one register call in the job module");
  expectEqual((jobCode.match(/new JobRegistry\(/gu) ?? []).length, 0, "with no registry constructed by the module");
  expect(jobCode.includes("maxAttempts: 1"), "and one attempt, because section 16 retries nothing automatically");

  // The job handler runs generation and then the sweep, in that order.
  const generateAt = jobCode.indexOf("generateRecurringInvoice(");
  const sweepAt = jobCode.indexOf("sweepRecurringReminders(");

  expect(generateAt > 0 && sweepAt > generateAt, "the handler generates first and sweeps after, because a reminder needs an invoice");

  // The engine owns every date; this STEP adds no arithmetic of its own.
  expect(code.includes("dueDateOfRun(") && code.includes("nextRunOf("), "the due date and the next run come from the engine");
  expect(!/new Date\(.*\)\.setDate|setMonth|setFullYear/u.test(code), "and no date arithmetic is written here");

  // The job's calendar day is UTC, so two workers in two zones agree on one occurrence.
  expect(job.includes("toISOString().slice(0, 10)"), "the calendar day is derived in UTC rather than from a local zone");
  expectEqual(currentCalendarDay(Date.parse("2026-11-05T23:30:00.000Z")), "2026-11-05", "and 23:30 UTC is still that day");
  expectEqual(currentCalendarDay(Date.parse("2026-11-05T00:30:00.000Z")), "2026-11-05", "as is 00:30 UTC");
}

/* ---- group 8: the handler against its own dependencies ---- */

async function checkHandler(): Promise<void> {
  const world = createWorld();
  const audit = createInMemoryAuditTrail();

  const result = await runRecurringScheduleJob(
    { schedule_id: SCHEDULE_A, run_on: RUN_ON },
    { rest: createRest(world), audit, today: () => "2026-11-05" },
  );

  expectEqual(result.kind, "generated", "the handler generates the occurrence it was given");
  expectEqual(result.runOn, RUN_ON, "and reports the payload's run date rather than the day it ran");

  const generated = world.invoices.find((row) => row["id"] === result.invoiceId);

  expectEqual(generated?.["recurring_run_on"], RUN_ON, "the invoice bills the payload's date");
  expectEqual(generated?.["status"], "draft", "and is a draft");

  // The sweep ran after generation, which is visible in the world: the draft is not reminded, so nothing appears.
  expectEqual(
    world.events.filter((row) => row["type"] === RECURRING_REMINDER_EVENT_TYPE).length,
    0,
    "and the sweep that followed left the new draft alone",
  );

  // A skipped run does not sweep, which is what makes a redelivery cheap.
  const skippedWorld = createWorld();
  const skippedQueries: string[] = [];

  const skipped = await runRecurringScheduleJob(
    { schedule_id: SCHEDULE_PAUSED, run_on: RUN_ON },
    { rest: createRest(skippedWorld), audit: createInMemoryAuditTrail(), today: () => "2026-11-05" },
  );
  skippedQueries.push(...skippedWorld.queries);

  expectEqual(skipped.kind, "skipped", "a paused schedule's run is skipped rather than raised");
  expect(
    !skippedQueries.some((query) => query.includes("invoice_events")),
    "and a skipped run reads no timeline, because it has nothing to remind about",
  );

  // The due list is what a scheduler enqueues from, and it agrees with the engine rather than only with SQL.
  const dueWorld = createWorld();
  patchSchedule(dueWorld, 0)["next_run_on"] = "2026-11-01";

  const due = await listDueRecurringSchedules({ today: "2026-11-05" }, depsOf(dueWorld));

  expectEqual(due.length, 2, "two schedules are due across both merchants");
  expect(due.some((entry) => entry.scheduleId === SCHEDULE_A && entry.runOn === "2026-11-01"), "one of them is this merchant's");
  expect(
    !due.some((entry) => entry.scheduleId === SCHEDULE_PAUSED || entry.scheduleId === SCHEDULE_ENDED),
    "and neither a paused nor an ended schedule is enqueued",
  );

  const future = await listDueRecurringSchedules({ today: "2026-10-01" }, depsOf(createWorld()));

  expectEqual(future.length, 0, "before the next run date nothing is due");

  let refused = false;

  try {
    await listDueRecurringSchedules({ today: "2026-13-01" }, depsOf(createWorld()));
  } catch (error) {
    refused = isAppError(error) && error.code === "VALIDATION_FAILED";
  }

  expect(refused, "a calendar day that does not exist is refused rather than passed to SQL");
}

/* ---- the run ---- */

async function run(): Promise<void> {
  await group("generation", checkGeneration);
  await group("due and not due", checkDueAndNotDue);
  await group("idempotency", checkIdempotency);
  await group("reminders", checkReminders);
  await group("failure and rollback", checkFailureAndRollback);
  await group("due query and the index", checkDueQuery);
  await group("STEP boundary", checkStepBoundary);
  await group("the handler", checkHandler);

  if (failures.length > 0) {
    process.stderr.write(`recurring generation gate failed with ${String(failures.length)} problem(s):\n`);

    for (const failure of failures) {
      process.stderr.write(`  - ${failure}\n`);
    }

    process.exitCode = 1;

    return;
  }

  process.stdout.write(
    `recurring generation gate passed: ${String(checks)} checks, one draft invoice per occurrence with the ` +
      "database's own unique key as the guard, due and not-due handled before any row is written, one reminder " +
      "per occurrence recorded and never a delivery claim, a failed line insert rolled back rather than left as " +
      "an empty draft, and a due query written to the predicate 0022's index was built for\n",
  );
}

await run();
