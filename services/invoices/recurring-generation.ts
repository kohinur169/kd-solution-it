// path: services/invoices/recurring-generation.ts
import { z } from "zod";
import type { AuditTrail } from "../../lib/auth/audit.ts";
import { isConflictError, type RestClient } from "../../lib/auth/rest.ts";
import { AppError } from "../../lib/errors/app-error.ts";
import {
  isRecurringScheduleDate,
  daysBetweenRecurringDates,
  dueDateOfRun,
  isRecurringScheduleDue,
  nextRunOf,
  reminderOfInvoice,
  type RecurringDateInput,
} from "./recurring-schedule-engine.ts";
import { recurringScheduleRowSchema } from "./recurring-schedule.ts";
import {
  RECURRING_EVENT_ACTOR,
  RECURRING_EVENT_DETAIL_MAX,
  RECURRING_GENERATED_AUDIT_ACTION,
  RECURRING_GENERATED_STATUS,
  RECURRING_GENERATION_AUDIT_ENTITY,
  RECURRING_REMINDER_EVENT_TYPE,
  RECURRING_REMINDER_QUEUED_AUDIT_ACTION,
  RECURRING_REMINDER_STATUSES,
  RECURRING_SWEEP_COMPANY_LIMIT,
  RECURRING_SWEEP_INVOICE_LIMIT,
  RECURRING_TIMELINE_TABLE,
  isRecurringReminderStatus,
  recurringReminderDedupeKey,
} from "./recurring-generation-fields.ts";

/**
 * Section 27's recurring run: copy the template into a draft, and record the reminders the schedule promised.
 *
 * ## One invoice per occurrence, and the database says so
 *
 * The generation below is a `select` of the schedule, a `select` of the template, an `insert` of the invoice and
 * an `insert` of its lines. Read-then-write is exactly the shape that duplicates under concurrency, and this file
 * does not try to fix that with a lock it cannot take through PostgREST. `0119` fixes it instead: the invoice
 * insert carries `recurring_schedule_id` and `recurring_run_on`, and `invoices_recurring_run_key` is a unique
 * partial index over the trio. When two workers run the same occurrence, one insert wins and the other raises a
 * unique violation, which `isConflictError` turns into the `already_generated` outcome below. The check and the
 * write are then one act, performed by the only component that can perform it atomically.
 *
 * On that conflict the generator reports `skipped` rather than an error: a second run of an occurrence is a
 * normal Tuesday for an at-least-once queue, not a failure to be paged about.
 *
 * ## Why a generated invoice is a draft, and why that is not a shortcut
 *
 * `RECURRING_GENERATED_STATUS` is `draft`. Nothing in this STEP issues or sends a document: `0022`'s status
 * vocabulary has no `issued`, `takeInvoiceNumber` is only ever called from a workflow STEP 116 owns, and writing
 * `sent` here would mean inventing a number and an `issued_at` for a bill no merchant approved. A draft says
 * exactly what is true. The consequences are stated rather than hidden: until the issue action exists, generated
 * invoices are not visible as bills, and the reminder sweep below skips them because a document nobody received
 * cannot be late.
 *
 * ## Reminders are recorded, and delivery is somebody else's STEP
 *
 * An `overdue_reminder` row means the occurrence was *queued*. It does not mean an email was sent, and this file
 * never claims otherwise: no email is composed here, `lib/email` belongs to STEPs 221-230, and nothing in this
 * module learns whether a message was delivered. The row is the durable, idempotent record the email STEP will
 * read from, and `0119`'s unique key over `dedupe_key` is what makes a retried sweep record one occurrence once.
 *
 * ## The dates belong to the engine
 *
 * `dueDateOfRun`, `nextRunOf`, `isRecurringScheduleDue` and `reminderOfInvoice` all live in
 * `recurring-schedule-engine.ts`, which has no clock and is proved against leap days, the 31st of a month and an
 * off-by-one reminder cadence. This file chooses when to call them and never recomputes a date of its own. `today`
 * arrives as a parameter in the same spirit: the job passes the clock in, and a gate passes a fixed calendar.
 */

/** The collaborators, the same two every service in this family takes. */
export interface RecurringGenerationDependencies {
  readonly rest: RestClient;
  readonly audit: AuditTrail;
  /** Epoch milliseconds. Used only for `created_at` on the reminder row, never for a schedule date. */
  readonly now?: () => number;
}

/** What one generation attempt did. `skipped` is a normal outcome, not an error. */
export interface RecurringGenerationResult {
  readonly scheduleId: string;
  readonly runOn: string;
  readonly kind: "generated" | "skipped";
  readonly invoiceId: string | null;
  /** `paused`, `ended`, `not_due`, `template_not_draft`, `already_generated`. */
  readonly reason: string | null;
}

/** What one reminder sweep did, counted rather than narrated. */
export interface RecurringReminderSweepResult {
  readonly considered: number;
  readonly queued: number;
  readonly alreadyQueued: number;
  readonly skipped: number;
}

/** The row shape of `0119`'s invoice columns, read back after the insert. */
const generatedInvoiceRowSchema = z.object({
  id: z.string().uuid(),
  company_id: z.string().uuid(),
  recurring_schedule_id: z.string().uuid().nullable(),
  recurring_run_on: z.string().nullable(),
});

type GeneratedInvoiceRow = z.infer<typeof generatedInvoiceRowSchema>;

/** The columns a template is copied from, listed one by one: rule 17, never a `*`. */
const TEMPLATE_COLUMNS =
  "select=id,company_id,client_id,status,currency,client_name,client_email,client_address,memo,tax_minor";

const templateRowSchema = z.object({
  id: z.string().uuid(),
  company_id: z.string().uuid(),
  client_id: z.string().uuid(),
  status: z.string().min(1),
  currency: z.string().length(3),
  client_name: z.string().min(1),
  client_email: z.string().nullable(),
  client_address: z.string().nullable(),
  memo: z.string().nullable(),
  tax_minor: z.union([z.string(), z.number()]),
});

/** The line columns copied from the template, in the template's own order. */
const TEMPLATE_LINE_COLUMNS =
  "select=position,description,unit,quantity,unit_price_minor,discount_minor,product_id,service_id";

const templateLineRowSchema = z.object({
  position: z.number().int().min(1),
  description: z.string().min(1),
  unit: z.string().min(1),
  quantity: z.string().min(1),
  unit_price_minor: z.union([z.string(), z.number()]),
  discount_minor: z.union([z.string(), z.number()]),
  product_id: z.string().uuid().nullable(),
  service_id: z.string().uuid().nullable(),
});

const GENERATED_INVOICE_TABLE = "invoices";
const GENERATED_LINE_TABLE = "invoice_items";

/** The engine's view of a schedule row: the six fields every date function needs, and nothing more. */
function dateInputOf(schedule: z.infer<typeof recurringScheduleRowSchema>): RecurringDateInput {
  return {
    startOn: schedule.start_on,
    nextRunOn: schedule.next_run_on,
    endOn: schedule.end_on,
    lastRunOn: schedule.last_run_on,
    // `0028`'s two checks already bound these, and the row schema types them as plain strings and numbers; the
    // engine validates the unit itself and treats an unknown one as a monthly step, so no cast is needed here.
    intervalUnit: schedule.interval_unit as RecurringDateInput["intervalUnit"],
    intervalCount: schedule.interval_count,
  };
}

/** Money arrives from PostgREST as a numeric string or a number; either way it is carried, never computed on. */
function priceText(value: string | number): string {
  return typeof value === "number" ? String(value) : value;
}

/**
 * Run one occurrence of one schedule.
 *
 * `runOn` is the occurrence the job was scheduled for - the date from the payload, never the day the worker
 * happened to start. A run delivered a day late still bills the period it was for, and its due date is measured
 * from that date, which is why the argument is required rather than read from a clock.
 *
 * The checks, in order, because an early refusal is cheaper than a late one:
 *
 *   1. the schedule exists, is live and belongs to a company - one read, scoped by the row's own tenant;
 *   2. it is not paused or ended, and `runOn` is not in its past (`last_run_on`) or its future (`next_run_on`);
 *   3. the template is still a draft - a merchant who issued it meant to stop copying it;
 *   4. the invoice insert, where the unique index is the final word on a double run;
 *   5. the lines, then the schedule's own `last_run_on` and `next_run_on`;
 *   6. the audit entry, which never carries a client name or an amount.
 */
export async function generateRecurringInvoice(
  input: { readonly scheduleId: string; readonly runOn: string },
  dependencies: RecurringGenerationDependencies,
): Promise<RecurringGenerationResult> {
  if (!isRecurringScheduleDate(input.runOn)) {
    throw new AppError("VALIDATION_FAILED", {
      details: [{ field: "run_on", rule: "invalid_format" }],
    });
  }

  const [schedule] = await dependencies.rest.select(
    "recurring_schedules",
    `select=id,company_id,client_id,template_invoice_id,status,interval_unit,interval_count,start_on,` +
      `next_run_on,end_on,terms_days,reminder_interval_days,reminder_limit,last_run_on,last_reminder_on,` +
      `paused_at,ended_at,created_at,updated_at,deleted_at,version` +
      `&id=eq.${input.scheduleId}&deleted_at=is.null`,
    recurringScheduleRowSchema,
  );

  // A schedule that is gone is reported as `skipped` rather than raised: the queue row was valid when it was
  // written, and a merchant deleting a schedule must not turn every queued run into a page.
  if (schedule === undefined) {
    return { scheduleId: input.scheduleId, runOn: input.runOn, kind: "skipped", invoiceId: null, reason: "missing" };
  }

  if (schedule.status === "paused") {
    return { scheduleId: schedule.id, runOn: input.runOn, kind: "skipped", invoiceId: null, reason: "paused" };
  }

  if (schedule.status === "ended") {
    return { scheduleId: schedule.id, runOn: input.runOn, kind: "skipped", invoiceId: null, reason: "ended" };
  }

  // The occurrence must be the one the schedule is waiting for. A run that arrives early is a queue bug, and a
  // run for a date the schedule has already filled is a redelivery - both are refused before a row is written,
  // and the unique index below is what catches the case where two of them race past this check together.
  if (schedule.next_run_on !== input.runOn) {
    return {
      scheduleId: schedule.id,
      runOn: input.runOn,
      kind: "skipped",
      invoiceId: null,
      // A date at or before the last run is a redelivery; anything else is simply not due yet.
      reason:
        schedule.last_run_on !== null &&
        daysBetweenRecurringDates(input.runOn, schedule.last_run_on) >= 0
          ? "already_generated"
          : "not_due",
    };
  }

  const endOn = schedule.end_on;

  // `daysBetween(from, to)` is `to - from`, so asking "is this run after the end date" means measuring from the
  // end date to the run and testing for a positive result. The opposite order silently passes every occurrence.
  if (endOn !== null && daysBetweenRecurringDates(endOn, input.runOn) > 0) {
    return { scheduleId: schedule.id, runOn: input.runOn, kind: "skipped", invoiceId: null, reason: "ended" };
  }

  const [template] = await dependencies.rest.select(
    GENERATED_INVOICE_TABLE,
    `${TEMPLATE_COLUMNS}&id=eq.${schedule.template_invoice_id}&company_id=eq.${schedule.company_id}` +
      `&deleted_at=is.null`,
    templateRowSchema,
  );

  if (template === undefined) {
    return {
      scheduleId: schedule.id,
      runOn: input.runOn,
      kind: "skipped",
      invoiceId: null,
      reason: "template_missing",
    };
  }

  // `recurring_schedules_guard_template` refuses an issued template in the database; reading first turns that
  // exception - which reaches the REST layer as a violation with no field - into a reason a report can count.
  if (template.status !== RECURRING_GENERATED_STATUS) {
    return {
      scheduleId: schedule.id,
      runOn: input.runOn,
      kind: "skipped",
      invoiceId: null,
      reason: "template_not_draft",
    };
  }

  const lines = await dependencies.rest.select(
    GENERATED_LINE_TABLE,
    `${TEMPLATE_LINE_COLUMNS}&invoice_id=eq.${template.id}&company_id=eq.${schedule.company_id}` +
      `&deleted_at=is.null&order=position.asc`,
    templateLineRowSchema,
  );

  // A template with no lines is not a document, and copying it would produce a draft worth nothing. The schedule
  // service already refuses to create one from an empty template, so this is the schedule-edited-since case.
  if (lines.length === 0) {
    return {
      scheduleId: schedule.id,
      runOn: input.runOn,
      kind: "skipped",
      invoiceId: null,
      reason: "template_empty",
    };
  }

  const dueAt = `${dueDateOfRun(input.runOn, schedule.terms_days)}T00:00:00.000Z`;

  let invoice: GeneratedInvoiceRow;

  try {
    const [row] = await dependencies.rest.insertReturning(
      GENERATED_INVOICE_TABLE,
      [
        {
          company_id: schedule.company_id,
          client_id: template.client_id,
          // A draft, and `number` and `issued_at` are absent rather than null: `0022` allows null there, and a
          // generator that filled them would be allocating an invoice number for a bill nobody issued.
          status: RECURRING_GENERATED_STATUS,
          currency: template.currency,
          client_name: template.client_name,
          client_email: template.client_email,
          client_address: template.client_address,
          memo: template.memo,
          tax_minor: priceText(template.tax_minor),
          due_at: dueAt,
          // `0119`: the occurrence, which is what the unique index is over. Both are set together because
          // `invoices_recurring_pair_check` refuses one without the other.
          recurring_schedule_id: schedule.id,
          recurring_run_on: input.runOn,
        },
      ],
      generatedInvoiceRowSchema,
    );

    if (row === undefined) {
      throw new AppError("INTERNAL_ERROR");
    }

    invoice = row;
  } catch (error) {
    // The unique index speaking. Another worker filled this occurrence first, or this exact run is a redelivery
    // that raced past the `next_run_on` check above; either way the occurrence has its invoice and this run has
    // nothing left to do.
    if (isConflictError(error)) {
      return {
        scheduleId: schedule.id,
        runOn: input.runOn,
        kind: "skipped",
        invoiceId: null,
        reason: "already_generated",
      };
    }

    throw error;
  }

  try {
    await dependencies.rest.insert(
      GENERATED_LINE_TABLE,
      lines.map((line) => ({
        company_id: schedule.company_id,
        invoice_id: invoice.id,
        position: line.position,
        description: line.description,
        unit: line.unit,
        quantity: line.quantity,
        unit_price_minor: priceText(line.unit_price_minor),
        discount_minor: priceText(line.discount_minor),
        product_id: line.product_id,
        service_id: line.service_id,
      })),
    );
  } catch (error) {
    // The lines failed, so the invoice is not a document. It is removed rather than left as an empty draft in the
    // merchant's list, and the removal is scoped by tenant and by the `recurring_schedule_id` this run wrote, so a
    // compensating write can never touch a row it did not create.
    await abandonGeneratedInvoice(dependencies, {
      companyId: schedule.company_id,
      invoiceId: invoice.id,
      scheduleId: schedule.id,
      runOn: input.runOn,
    });

    throw error;
  }

  // The schedule's own bookkeeping: this occurrence is filled, and the next one is the engine's, computed from the
  // anchor rather than by adding an interval to `runOn`, so a year of clamped months cannot drift.
  const nextRunOn = nextRunOf({ ...dateInputOf(schedule), lastRunOn: input.runOn });

  await dependencies.rest.update(
    "recurring_schedules",
    `id=eq.${schedule.id}&company_id=eq.${schedule.company_id}`,
    { last_run_on: input.runOn, next_run_on: nextRunOn },
  );

  // Re-read after the update: PostgREST reports a zero-row PATCH as success, so the only honest way to know the
  // schedule actually moved is to look. A schedule that did not move would run this occurrence again, which the
  // unique index would then refuse - but the merchant's next invoice would never arrive.
  const [moved] = await dependencies.rest.select(
    "recurring_schedules",
    `select=id,last_run_on,next_run_on&id=eq.${schedule.id}&company_id=eq.${schedule.company_id}`,
    z.object({
      id: z.string().uuid(),
      last_run_on: z.string().nullable(),
      next_run_on: z.string(),
    }),
  );

  if (moved === undefined || moved.last_run_on !== input.runOn) {
    throw new AppError("INTERNAL_ERROR");
  }

  await appendTolerated(dependencies.audit, {
    action: RECURRING_GENERATED_AUDIT_ACTION,
    // A scheduled run has no person behind it. `0013` allows a null actor, and inventing one would blame a
    // merchant for the platform's timetable.
    actorUserId: null,
    entityType: RECURRING_GENERATION_AUDIT_ENTITY,
    entityId: schedule.id,
    companyId: schedule.company_id,
    payload: {
      run_on: input.runOn,
      next_run_on: nextRunOn,
      invoice_id: invoice.id,
      line_count: lines.length,
      // No client name and no amount: an audit entry is read by support staff and a client name in it is a name
      // in a log line, which rule 14's spirit and STEP 122's sweep both refuse.
    },
  });

  return { scheduleId: schedule.id, runOn: input.runOn, kind: "generated", invoiceId: invoice.id, reason: null };
}

/** Remove a generated invoice whose lines could not be written, then audit that it was abandoned. */
async function abandonGeneratedInvoice(
  dependencies: RecurringGenerationDependencies,
  input: {
    readonly companyId: string;
    readonly invoiceId: string;
    readonly scheduleId: string;
    readonly runOn: string;
  },
): Promise<void> {
  try {
    await dependencies.rest.update(
      GENERATED_INVOICE_TABLE,
      `id=eq.${input.invoiceId}&company_id=eq.${input.companyId}` +
        `&recurring_schedule_id=eq.${input.scheduleId}&status=eq.${RECURRING_GENERATED_STATUS}`,
      { deleted_at: new Date(dependencies.now?.() ?? Date.now()).toISOString() },
    );
  } catch {
    // A compensating action that fails must not replace the failure the caller needs to see.
  }
}

/**
 * Record the reminder one invoice earns today, if it earns one.
 *
 * `sentCount` is not a delivery count and this function does not pretend it is: it is the number of reminder
 * occurrences already **recorded** for the invoice, counted from `invoice_events` below. An occurrence that was
 * recorded and whose email later failed is still recorded, so the next sweep does not queue it twice; making the
 * email succeed is STEP 221-230's problem, and re-sending is their decision, not a second event.
 *
 * The idempotency is again the index rather than this function's arithmetic: the insert carries a `dedupe_key`
 * naming the occurrence, and `0119`'s unique partial index refuses the second one. The read below exists to give
 * the caller an honest count and to avoid a pointless round trip, not to be the guard.
 */
export async function recordRecurringReminder(
  input: {
    readonly companyId: string;
    readonly invoiceId: string;
    readonly scheduleId: string;
    readonly runOn: string;
    readonly dueOn: string;
    readonly reminderIntervalDays: number;
    readonly reminderLimit: number;
    readonly today: string;
  },
  dependencies: RecurringGenerationDependencies,
): Promise<{ readonly queued: boolean; readonly ordinal: number | null }> {
  const existing = await dependencies.rest.select(
    RECURRING_TIMELINE_TABLE,
    `select=dedupe_key&company_id=eq.${input.companyId}&invoice_id=eq.${input.invoiceId}` +
      `&type=eq.${RECURRING_REMINDER_EVENT_TYPE}&deleted_at=is.null`,
    z.object({ dedupe_key: z.string().nullable() }),
  );

  const recorded = existing.filter((row) => row.dedupe_key !== null).length;

  const ordinal = reminderOfInvoice({
    dueOn: input.dueOn,
    today: input.today,
    sentCount: recorded,
    reminderIntervalDays: input.reminderIntervalDays,
    reminderLimit: input.reminderLimit,
  });

  if (ordinal === null) {
    return { queued: false, ordinal: null };
  }

  const dedupeKey = recurringReminderDedupeKey({
    scheduleId: input.scheduleId,
    runOn: input.runOn,
    invoiceId: input.invoiceId,
    ordinal,
  });

  const detail = `Reminder ${String(ordinal)} of ${String(input.reminderLimit)} for the invoice due ${input.dueOn}.`;

  try {
    await dependencies.rest.insert(RECURRING_TIMELINE_TABLE, [
      {
        company_id: input.companyId,
        invoice_id: input.invoiceId,
        type: RECURRING_REMINDER_EVENT_TYPE,
        actor: RECURRING_EVENT_ACTOR,
        actor_user_id: null,
        detail: detail.slice(0, RECURRING_EVENT_DETAIL_MAX),
        dedupe_key: dedupeKey,
      },
    ]);
  } catch (error) {
    if (isConflictError(error)) {
      return { queued: false, ordinal: null };
    }

    throw error;
  }

  await appendTolerated(dependencies.audit, {
    action: RECURRING_REMINDER_QUEUED_AUDIT_ACTION,
    actorUserId: null,
    entityType: "invoice",
    entityId: input.invoiceId,
    companyId: input.companyId,
    payload: {
      schedule_id: input.scheduleId,
      run_on: input.runOn,
      ordinal,
      dedupe_key: dedupeKey,
      // Explicitly not a delivery fact. The handoff and the field comment both say `queued`, and the audit trail
      // says it too, so nobody reading the log later confuses this row with a sent message.
      delivery: "not_attempted",
    },
  });

  return { queued: true, ordinal };
}

/**
 * Record every reminder the schedules promised for one merchant today.
 *
 * The invoice query is written to the shape `0022`'s `invoices_due_idx` was built for: the same three statuses in
 * the same order, `deleted_at is null`, and a range on `due_at` rather than a function of it. The index is never
 * called - it is chosen by the planner when the predicate matches - and the constants above are that predicate
 * written once so the query and the index cannot drift apart without a gate noticing.
 *
 * Only generated invoices are swept, because only a generated invoice knows which schedule's reminder policy
 * applies to it. A hand-written invoice has no `recurring_schedule_id`, and section 16's reminder cadence is a
 * property of a recurring schedule rather than of an invoice.
 */
export async function sweepRecurringReminders(
  input: { readonly companyId: string; readonly today: string },
  dependencies: RecurringGenerationDependencies,
): Promise<RecurringReminderSweepResult> {
  if (!isRecurringScheduleDate(input.today)) {
    throw new AppError("VALIDATION_FAILED", { details: [{ field: "today", rule: "invalid_format" }] });
  }

  const invoices = await dependencies.rest.select(
    GENERATED_INVOICE_TABLE,
    `select=id,company_id,client_id,status,due_at,recurring_schedule_id,recurring_run_on` +
      `&company_id=eq.${input.companyId}&deleted_at=is.null` +
      `&status=in.(${RECURRING_REMINDER_STATUSES.join(",")})` +
      `&recurring_schedule_id=not.is.null` +
      // The due date is compared, not computed on: `due_at` is a timestamptz and the sweep is a calendar day, so
      // the range is the day's own bounds. A `date(due_at)` wrapper would defeat the index on a large table.
      `&due_at=lt.${input.today}T00:00:00.000Z` +
      `&order=due_at.asc&limit=${String(RECURRING_SWEEP_INVOICE_LIMIT)}`,
    z.object({
      id: z.string().uuid(),
      company_id: z.string().uuid(),
      client_id: z.string().uuid(),
      status: z.string().min(1),
      due_at: z.string().min(1),
      recurring_schedule_id: z.string().uuid().nullable(),
      recurring_run_on: z.string().nullable(),
    }),
  );

  let queued = 0;
  let alreadyQueued = 0;
  let skipped = 0;

  for (const invoice of invoices) {
    if (!isRecurringReminderStatus(invoice.status)) {
      skipped += 1;
      continue;
    }

    if (invoice.recurring_schedule_id === null || invoice.recurring_run_on === null) {
      skipped += 1;
      continue;
    }

    const [schedule] = await dependencies.rest.select(
      "recurring_schedules",
      `select=id,company_id,status,reminder_interval_days,reminder_limit` +
        `&id=eq.${invoice.recurring_schedule_id}&company_id=eq.${input.companyId}&deleted_at=is.null`,
      z.object({
        id: z.string().uuid(),
        company_id: z.string().uuid(),
        status: z.string().min(1),
        reminder_interval_days: z.number().int(),
        reminder_limit: z.number().int(),
      }),
    );

    // A paused or ended schedule stops reminding, which is what a merchant who paused it asked for. The invoice
    // stays late and stays visible; only the cadence stops.
    if (schedule === undefined || schedule.status !== "active") {
      skipped += 1;
      continue;
    }

    const result = await recordRecurringReminder(
      {
        companyId: input.companyId,
        invoiceId: invoice.id,
        scheduleId: schedule.id,
        runOn: invoice.recurring_run_on,
        dueOn: invoice.due_at.slice(0, 10),
        reminderIntervalDays: schedule.reminder_interval_days,
        reminderLimit: schedule.reminder_limit,
        today: input.today,
      },
      dependencies,
    );

    if (result.queued) {
      queued += 1;
    } else {
      alreadyQueued += 1;
    }
  }

  return { considered: invoices.length, queued, alreadyQueued, skipped };
}

/**
 * Record the reminders of every merchant with generated invoices, one merchant at a time.
 *
 * A reminder is a per-invoice question, but the sweeps are per merchant for the same reason every other read in
 * this repository is: the tenant is read from a session or from the invoice's own row, and a sweep that crossed
 * merchants would be the one query in the codebase allowed to see two companies at once.
 */
export async function sweepAllRecurringReminders(
  input: { readonly today: string },
  dependencies: RecurringGenerationDependencies,
): Promise<RecurringReminderSweepResult & { readonly companies: number }> {
  const companies = await dependencies.rest.select(
    GENERATED_INVOICE_TABLE,
    `select=company_id&deleted_at=is.null&recurring_schedule_id=not.is.null` +
      `&status=in.(${RECURRING_REMINDER_STATUSES.join(",")})` +
      `&due_at=lt.${input.today}T00:00:00.000Z&limit=${String(RECURRING_SWEEP_COMPANY_LIMIT)}`,
    z.object({ company_id: z.string().uuid() }),
  );

  const distinct = [...new Set(companies.map((row) => row.company_id))];

  let considered = 0;
  let queued = 0;
  let alreadyQueued = 0;
  let skipped = 0;

  for (const companyId of distinct) {
    const result = await sweepRecurringReminders({ companyId, today: input.today }, dependencies);
    considered += result.considered;
    queued += result.queued;
    alreadyQueued += result.alreadyQueued;
    skipped += result.skipped;
  }

  return { considered, queued, alreadyQueued, skipped, companies: distinct.length };
}

/** The schedules that are due today, which is what a scheduler enqueues one `recurring_schedule.generate` per. */
export async function listDueRecurringSchedules(
  input: { readonly today: string },
  dependencies: RecurringGenerationDependencies,
): Promise<readonly { readonly scheduleId: string; readonly companyId: string; readonly runOn: string }[]> {
  if (!isRecurringScheduleDate(input.today)) {
    throw new AppError("VALIDATION_FAILED", { details: [{ field: "today", rule: "invalid_format" }] });
  }

  const rows = await dependencies.rest.select(
    "recurring_schedules",
    `select=id,company_id,next_run_on&status=eq.active&deleted_at=is.null` +
      `&next_run_on=lte.${input.today}&order=next_run_on.asc&limit=${String(RECURRING_SWEEP_INVOICE_LIMIT)}`,
    z.object({
      id: z.string().uuid(),
      company_id: z.string().uuid(),
      next_run_on: z.string(),
    }),
  );

  // The predicate above is the database's; `isRecurringScheduleDue` is the engine's, and they must agree. The
  // filter is applied again here so a row that somehow reached this list with a future date is not enqueued -
  // the two answers are cheap to compare and expensive to disagree.
  return rows
    .filter((row) => isRecurringScheduleDue({ ...emptyScheduleDates(row.next_run_on), nextRunOn: row.next_run_on }, input.today))
    .map((row) => ({ scheduleId: row.id, companyId: row.company_id, runOn: row.next_run_on }));
}

/** The minimum a due check needs; only `next_run_on` matters to it. */
function emptyScheduleDates(nextRunOn: string): RecurringDateInput {
  return {
    startOn: nextRunOn,
    nextRunOn,
    endOn: null,
    lastRunOn: null,
    intervalUnit: "month",
    intervalCount: 1,
  };
}

async function appendTolerated(audit: AuditTrail, entry: Parameters<AuditTrail["append"]>[0]): Promise<void> {
  try {
    await audit.append(entry);
  } catch {
    // An audit sink that is down never fails the write it records.
  }
}
