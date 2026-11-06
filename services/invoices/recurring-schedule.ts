// path: services/invoices/recurring-schedule.ts
import { z } from "zod";
import type { AuditTrail } from "../../lib/auth/audit.ts";
import { isConflictError, type RestClient } from "../../lib/auth/rest.ts";
import { requireAnyRole, requireCompanyId } from "../../lib/auth/session.ts";
import type { PlatformRole, RequestActor } from "../../lib/auth/types.ts";
import { AppError, type ErrorDetail } from "../../lib/errors/app-error.ts";
import {
  RECURRING_SCHEDULE_COUNT_LIMITS,
  RECURRING_SCHEDULE_CREATED_STATUS,
  RECURRING_SCHEDULE_DEFAULT_TERMS_DAYS,
  RECURRING_SCHEDULE_DEFAULT_UNIT,
  RECURRING_SCHEDULE_REMINDER_INTERVAL_LIMITS,
  RECURRING_SCHEDULE_REMINDER_LIMIT_LIMITS,
  RECURRING_SCHEDULE_RULES,
  RECURRING_SCHEDULE_TERMS_LIMITS,
  isRecurringScheduleIntervalUnit,
  isRecurringScheduleStatus,
  type RecurringScheduleStatus,
} from "./recurring-schedule-fields.ts";
import { isRecurringScheduleDate, nextRunOf, type RecurringDateInput } from "./recurring-schedule-engine.ts";

/**
 * Section 16's recurring invoice schedule: a draft template you pick, an interval, a due offset and a
 * reminder policy.
 *
 * ## The template is an invoice, and that is the whole design
 *
 * `0028` does not model a second catalogue. A schedule points at a **draft invoice** of the same merchant -
 * the template - and the section 27 job copies that invoice and its lines on each run. So the client, the
 * currency, the prices and the arithmetic are already proved by `services/invoices/invoices.ts`, and there is
 * no third place where a price could disagree with another. `recurring_schedules_guard_template` enforces the
 * three consequences in the database: same merchant, still a draft, same client as the template.
 *
 * That trigger is why this service *reads* the template before it writes. A trigger's `raise exception`
 * reaches the REST layer as a `check_violation`, which is a `VALIDATION_FAILED` with no field to point at -
 * so a merchant who picked a sent invoice would get a sentence about nothing. Reading first turns the same
 * rule into `{field: "template_invoice_id", rule: "not_draft"}`, which is a box the screen can mark.
 *
 * ## The dates are the engine's, never this file's
 *
 * `next_run_on`, every later run, the due date of a generated invoice and the reminder cadence are all decided
 * by `recurring-schedule-engine.ts`, which has no clock and is proved against leap days and the 31st of a
 * month. This module only chooses *which* of its functions to call and when. A second date arithmetic here
 * would be a second answer to "when does this run", and the two would disagree within a year.
 */

/** What a schedule needs: the same two collaborators every service in this family takes. */
export interface RecurringScheduleDependencies {
  readonly rest: RestClient;
  readonly audit: AuditTrail;
  /** Epoch milliseconds. Injected so a gate can convert "today" without touching the process clock. */
  readonly now?: () => number;
}

/** Who may configure a schedule. Section 25: a merchant's documents belong to its owner. */
export const RECURRING_SCHEDULE_MANAGE_ROLES: readonly PlatformRole[] = Object.freeze([
  "owner",
] as const satisfies readonly PlatformRole[]);

export const RECURRING_SCHEDULE_CREATED_AUDIT_ACTION = "recurring_schedule.created";
export const RECURRING_SCHEDULE_UPDATED_AUDIT_ACTION = "recurring_schedule.updated";
export const RECURRING_SCHEDULE_PAUSED_AUDIT_ACTION = "recurring_schedule.paused";
export const RECURRING_SCHEDULE_RESUMED_AUDIT_ACTION = "recurring_schedule.resumed";
export const RECURRING_SCHEDULE_ENDED_AUDIT_ACTION = "recurring_schedule.ended";
export const RECURRING_SCHEDULE_AUDIT_ENTITY = "recurring_schedule";

export const RECURRING_SCHEDULE_TABLE = "recurring_schedules";

/** The columns a read selects, listed one by one: rule 17, and never a `*`. */
export const RECURRING_SCHEDULE_COLUMNS = `select=${[
  "id",
  "company_id",
  "client_id",
  "template_invoice_id",
  "status",
  "interval_unit",
  "interval_count",
  "start_on",
  "next_run_on",
  "end_on",
  "terms_days",
  "reminder_interval_days",
  "reminder_limit",
  "last_run_on",
  "last_reminder_on",
  "paused_at",
  "ended_at",
  "created_at",
  "updated_at",
  "deleted_at",
  "version",
].join(",")}`;

/**
 * The row of `0028`, validated on every read.
 *
 * A `date` column arrives from PostgREST as `YYYY-MM-DD` and is kept as text: it is a calendar date, not an
 * instant, and parsing it into a `Date` here would be the first step of the drift this family avoids.
 */
export const recurringScheduleRowSchema = z.object({
  id: z.string().uuid(),
  company_id: z.string().uuid(),
  client_id: z.string().uuid(),
  template_invoice_id: z.string().uuid(),
  status: z.string().min(1),
  interval_unit: z.string().min(1),
  interval_count: z.number().int(),
  start_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
  next_run_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
  end_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).nullable(),
  terms_days: z.number().int(),
  reminder_interval_days: z.number().int(),
  reminder_limit: z.number().int(),
  last_run_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).nullable(),
  last_reminder_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).nullable(),
  paused_at: z.string().nullable(),
  ended_at: z.string().nullable(),
  created_at: z.string().min(1),
  updated_at: z.string().min(1),
  deleted_at: z.string().nullable(),
  version: z.number().int().min(1),
});

export type RecurringScheduleRow = z.infer<typeof recurringScheduleRowSchema>;

/** The four facts the template contributes, read from the invoice rather than trusted from a body. */
const templateRowSchema = z.object({
  id: z.string().uuid(),
  client_id: z.string().uuid(),
  status: z.string().min(1),
  total_minor: z.union([z.string(), z.number()]).transform((value) => String(value)),
  currency: z.string().length(3),
  number: z.string().nullable(),
});

export type RecurringScheduleTemplate = z.infer<typeof templateRowSchema>;

/** One schedule as a screen sees it. Money crosses as decimal text, because a `bigint` cannot cross JSON. */
export interface RecurringScheduleSnapshot {
  readonly id: string;
  readonly companyId: string;
  readonly clientId: string;
  readonly templateInvoiceId: string;
  readonly status: RecurringScheduleStatus;
  readonly intervalUnit: RecurringDateInput["intervalUnit"];
  readonly intervalCount: number;
  readonly startOn: string;
  readonly nextRunOn: string;
  readonly endOn: string | null;
  readonly termsDays: number;
  readonly reminderIntervalDays: number;
  readonly reminderLimit: number;
  readonly lastRunOn: string | null;
  readonly lastReminderOn: string | null;
  readonly pausedAtEpochMs: number | null;
  readonly endedAtEpochMs: number | null;
  /** The template's face, so a list does not need a second request per row. */
  readonly template: {
    readonly clientId: string;
    readonly currency: string;
    readonly totalMinor: string;
  };
  /** Every refusal of this service names one of these, so a form has a key for each. */
  readonly version: number;
  readonly createdAtEpochMs: number;
  readonly updatedAtEpochMs: number;
}

/**
 * The body of a create.
 *
 * `.strict()` so an unknown key is reported rather than silently dropped: a merchant who types
 * `reminder_interval` and gets no reminder would have no way to find out why.
 */
export const recurringScheduleCreateSchema = z
  .object({
    template_invoice_id: z.string(),
    interval_unit: z.string().nullish(),
    interval_count: z.union([z.string(), z.number()]).nullish(),
    start_on: z.string(),
    end_on: z.string().nullish(),
    terms_days: z.union([z.string(), z.number()]).nullish(),
    reminder_interval_days: z.union([z.string(), z.number()]).nullish(),
    reminder_limit: z.union([z.string(), z.number()]).nullish(),
  })
  .strict();

/** The body of an edit. The template is deliberately absent: a schedule's document cannot change under it. */
export const recurringScheduleUpdateSchema = z
  .object({
    interval_unit: z.string().nullish(),
    interval_count: z.union([z.string(), z.number()]).nullish(),
    start_on: z.string().nullish(),
    end_on: z.string().nullish(),
    terms_days: z.union([z.string(), z.number()]).nullish(),
    reminder_interval_days: z.union([z.string(), z.number()]).nullish(),
    reminder_limit: z.union([z.string(), z.number()]).nullish(),
    version: z.union([z.string(), z.number()]),
  })
  .strict();

/** The order fields are reported in, so a form marks the boxes top to bottom. */
const CREATE_FIELD_ORDER = [
  "template_invoice_id",
  "interval_unit",
  "interval_count",
  "start_on",
  "end_on",
  "terms_days",
  "reminder_interval_days",
  "reminder_limit",
] as const;

const UPDATE_FIELD_ORDER = [
  "interval_unit",
  "interval_count",
  "start_on",
  "end_on",
  "terms_days",
  "reminder_interval_days",
  "reminder_limit",
  "version",
] as const;

/** The rule vocabulary this service answers with, for the form's sentences. */
export { RECURRING_SCHEDULE_RULES };

/**
 * The instant "today" is, in the merchant's calendar.
 *
 * A schedule is configured against a calendar date, and which date it is depends on where the merchant is -
 * so the client sends its own today and this service validates it. It is not trusted for anything that
 * matters: the dates it produces are checked against `0028`'s own constraints, and a caller who sends a wrong
 * today only moves its own schedule. The alternative is worse, because a server in UTC would tell a merchant
 * in Dhaka that it is still yesterday for six hours of every day.
 */
export const recurringScheduleTodayPattern = /^\d{4}-\d{2}-\d{2}$/u;

/** Every value a body may carry, parsed and converted. */
interface ScheduleInput {
  readonly templateInvoiceId: string;
  readonly intervalUnit: RecurringDateInput["intervalUnit"];
  readonly intervalCount: number;
  readonly startOn: string;
  readonly endOn: string | null;
  readonly termsDays: number;
  readonly reminderIntervalDays: number;
  readonly reminderLimit: number;
}

/** Parse an integer that may arrive as text from a form or as a number from JSON. */
function numberOf(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isInteger(value) ? value : null;
  }

  if (typeof value !== "string" || !/^\d{1,6}$/u.test(value.trim())) {
    return null;
  }

  return Number.parseInt(value.trim(), 10);
}

/** A bound check that reports against its own field. */
function bounded(
  value: number,
  limits: { readonly min: number; readonly max: number },
  field: string,
  problems: ErrorDetail[],
): void {
  if (value < limits.min) {
    problems.push({ field, rule: "too_small" });
  } else if (value > limits.max) {
    problems.push({ field, rule: "too_large" });
  }
}

/**
 * Parse a create body into the values the row needs, naming every broken field of it.
 *
 * A schedule is eight independent judgements, and stopping at the first would make a merchant fix one box per
 * save. Each is evaluated and the first rule per field wins, the same discipline `parseInvoiceLine` follows.
 */
export function parseRecurringScheduleCreate(body: unknown): ScheduleInput {
  const parsed = recurringScheduleCreateSchema.safeParse(body);

  if (!parsed.success) {
    throw problemsOf(parsed.error, [...CREATE_FIELD_ORDER]);
  }

  const raw = parsed.data;
  const problems: ErrorDetail[] = [];

  if (!z.string().uuid().safeParse(raw.template_invoice_id).success) {
    problems.push({ field: "template_invoice_id", rule: "invalid_format" });
  }

  const unitRaw = (raw.interval_unit ?? "").trim();
  const intervalUnit = unitRaw.length === 0 ? RECURRING_SCHEDULE_DEFAULT_UNIT : unitRaw;

  if (!isRecurringScheduleIntervalUnit(intervalUnit)) {
    problems.push({ field: "interval_unit", rule: "invalid_format" });
  }

  const intervalCount = numberOf(raw.interval_count ?? 1) ?? 0;

  if (numberOf(raw.interval_count ?? 1) === null) {
    problems.push({ field: "interval_count", rule: "invalid_format" });
  } else {
    bounded(intervalCount, RECURRING_SCHEDULE_COUNT_LIMITS, "interval_count", problems);
  }

  const startOn = (raw.start_on ?? "").trim();

  if (startOn.length === 0) {
    problems.push({ field: "start_on", rule: "required" });
  } else if (!isRecurringScheduleDate(startOn)) {
    problems.push({ field: "start_on", rule: "invalid_format" });
  }

  const endRaw = raw.end_on ?? null;
  let endOn: string | null = null;

  if (endRaw !== null) {
    const trimmed = String(endRaw).trim();

    if (trimmed.length > 0) {
      if (!isRecurringScheduleDate(trimmed)) {
        problems.push({ field: "end_on", rule: "invalid_format" });
      } else {
        endOn = trimmed;
      }
    }
  }

  const termsDays = numberOf(raw.terms_days ?? RECURRING_SCHEDULE_DEFAULT_TERMS_DAYS);

  if (termsDays === null) {
    problems.push({ field: "terms_days", rule: "invalid_format" });
  } else {
    bounded(termsDays, RECURRING_SCHEDULE_TERMS_LIMITS, "terms_days", problems);
  }

  const reminderIntervalDays = numberOf(raw.reminder_interval_days ?? 0);

  if (reminderIntervalDays === null) {
    problems.push({ field: "reminder_interval_days", rule: "invalid_format" });
  } else {
    bounded(reminderIntervalDays, RECURRING_SCHEDULE_REMINDER_INTERVAL_LIMITS, "reminder_interval_days", problems);
  }

  const reminderLimit = numberOf(raw.reminder_limit ?? 0);

  if (reminderLimit === null) {
    problems.push({ field: "reminder_limit", rule: "invalid_format" });
  } else {
    bounded(reminderLimit, RECURRING_SCHEDULE_REMINDER_LIMIT_LIMITS, "reminder_limit", problems);
  }

  // `recurring_schedules_reminder_pair_check`: zero days is no reminders, and the limit is zero with it. This
  // is the one rule of `0028` that relates two fields, so it is reported against the pair rather than against
  // whichever of them happened to be typed second.
  if (reminderIntervalDays !== null && reminderLimit !== null) {
    if (reminderIntervalDays === 0 && reminderLimit !== 0) {
      problems.push({ field: "reminder_limit", rule: "invalid_format" });
    } else if (reminderIntervalDays !== 0 && reminderLimit === 0) {
      problems.push({ field: "reminder_limit", rule: "too_small" });
    }
  }

  // `recurring_schedules_end_check`: an end before the start is not a schedule, it is a typo.
  if (endOn !== null && isRecurringScheduleDate(startOn) && endOn < startOn) {
    problems.push({ field: "end_on", rule: "too_small" });
  }

  if (problems.length > 0) {
    throw new AppError("VALIDATION_FAILED", { details: problems });
  }

  return {
    templateInvoiceId: raw.template_invoice_id,
    intervalUnit: intervalUnit as RecurringDateInput["intervalUnit"],
    intervalCount,
    startOn,
    endOn,
    termsDays: termsDays ?? RECURRING_SCHEDULE_DEFAULT_TERMS_DAYS,
    reminderIntervalDays: reminderIntervalDays ?? 0,
    reminderLimit: reminderLimit ?? 0,
  };
}

/** Map a Zod failure onto this service's rule vocabulary, in the order a form reads. */
function problemsOf(error: z.ZodError, order: readonly string[]): AppError {
  const details: ErrorDetail[] = error.issues.map((issue) => {
    // A `strict()` object reports an unknown key with an empty `path` and the keys in `issue.keys`, so naming
    // the key itself is what lets a form mark the box the merchant actually typed. Falling back to the first
    // field in reading order would blame a field that was fine.
    if (issue.code === "unrecognized_keys") {
      return { field: issue.keys[0] ?? "body", rule: "unknown_field" };
    }

    return {
      field: issue.path.length === 0 ? order[0] ?? "body" : String(issue.path[0]),
      rule: "invalid_format",
    };
  });

  const rank = (field: string): number => {
    const index = order.indexOf(field);

    return index === -1 ? order.length : index;
  };

  return new AppError("VALIDATION_FAILED", {
    details: [...details].sort((left, right) => rank(left.field) - rank(right.field)),
  });
}

/** The template's facts, or a refusal that names the field the merchant chose. */
async function readTemplate(
  rest: RestClient,
  companyId: string,
  templateInvoiceId: string,
): Promise<RecurringScheduleTemplate> {
  const rows = await rest.select(
    "invoices",
    `select=id,client_id,status,total_minor,currency,number&id=eq.${templateInvoiceId}&company_id=eq.${companyId}&deleted_at=is.null`,
    templateRowSchema,
  );
  const row = rows[0];

  if (row === undefined) {
    throw new AppError("VALIDATION_FAILED", {
      details: [{ field: "template_invoice_id", rule: "not_found" }],
    });
  }

  // `recurring_schedules_guard_template`: the template has to still be a draft. Reading first is what turns
  // the trigger's exception into a field a screen can mark.
  if (row.status !== "draft") {
    throw new AppError("VALIDATION_FAILED", {
      details: [{ field: "template_invoice_id", rule: "not_draft" }],
    });
  }

  return row;
}

/**
 * Create one schedule.
 *
 * The order is the trigger's, restated as refusals a form can render: the template must exist in this
 * merchant's book, must still be a draft, and `next_run_on` starts at `start_on` because the schedule has
 * not run yet. `recurring_schedules_template_key` then makes "one live schedule per template" the database's
 * answer rather than a read that could be stale by the time the insert lands, so a racing second create
 * arrives here as a conflict.
 */
export async function createRecurringSchedule(
  input: { readonly actor: RequestActor; readonly body: unknown },
  dependencies: RecurringScheduleDependencies,
): Promise<RecurringScheduleSnapshot> {
  const companyId = requireRecurringActor(input.actor);
  const values = parseRecurringScheduleCreate(input.body);
  const template = await readTemplate(dependencies.rest, companyId, values.templateInvoiceId);

  const newRow: Record<string, unknown> = {
    company_id: companyId,
    client_id: template.client_id,
    template_invoice_id: values.templateInvoiceId,
    status: RECURRING_SCHEDULE_CREATED_STATUS,
    interval_unit: values.intervalUnit,
    interval_count: values.intervalCount,
    start_on: values.startOn,
    // The first run is the merchant's own choice of start date: the schedule has never run, so the engine's
    // anchor rule and the stored next run are the same fact.
    next_run_on: values.startOn,
    end_on: values.endOn,
    terms_days: values.termsDays,
    reminder_interval_days: values.reminderIntervalDays,
    reminder_limit: values.reminderLimit,
  };

  let row: RecurringScheduleRow;

  try {
    const [created] = await dependencies.rest.insertReturning(
      RECURRING_SCHEDULE_TABLE,
      [newRow],
      recurringScheduleRowSchema,
    );

    if (created === undefined) {
      throw new AppError("INTERNAL_ERROR", { cause: { rule: "recurring_schedule", reason: "insert_returned_no_row" } });
    }

    row = created;
  } catch (error) {
    // `recurring_schedules_template_key`: the template already drives a live schedule. PostgREST answers a
    // unique violation as a 409, which is the one failure of this insert that maps to CONFLICT.
    if (isConflictError(error)) {
      throw new AppError("CONFLICT", {
        details: [{ field: "template_invoice_id", rule: "already_used" }],
        cause: { rule: "recurring_schedule", reason: "template_taken" },
      });
    }

    throw error;
  }

  await appendTolerated(dependencies.audit, {
    action: RECURRING_SCHEDULE_CREATED_AUDIT_ACTION,
    actorUserId: input.actor.userId,
    entityType: RECURRING_SCHEDULE_AUDIT_ENTITY,
    entityId: row.id,
    companyId,
    sessionId: input.actor.sessionId ?? null,
    payload: {
      // The shape of the policy, never the client's name and never an amount: a schedule is configuration,
      // and the trail records what was configured rather than what it will eventually bill.
      template_invoice_id: row.template_invoice_id,
      interval_unit: row.interval_unit,
      interval_count: row.interval_count,
      start_on: row.start_on,
      terms_days: row.terms_days,
      reminders: row.reminder_interval_days > 0,
      reminder_interval_days: row.reminder_interval_days,
      reminder_limit: row.reminder_limit,
    },
  });

  return snapshotOf(row, template);
}

/** One schedule by id, scoped to the merchant. */
export async function getRecurringSchedule(
  input: { readonly actor: RequestActor; readonly scheduleId: string },
  dependencies: RecurringScheduleDependencies,
): Promise<RecurringScheduleSnapshot> {
  const companyId = requireRecurringActor(input.actor);

  if (!z.string().uuid().safeParse(input.scheduleId).success) {
    throw new AppError("VALIDATION_FAILED", { details: [{ field: "id", rule: "invalid_format" }] });
  }

  const rows = await dependencies.rest.select(
    RECURRING_SCHEDULE_TABLE,
    `${RECURRING_SCHEDULE_COLUMNS}&id=eq.${input.scheduleId}&company_id=eq.${companyId}&deleted_at=is.null`,
    recurringScheduleRowSchema,
  );
  const row = rows[0];

  if (row === undefined) {
    throw new AppError("RESOURCE_NOT_FOUND", { cause: { rule: "recurring_schedule", reason: "not_found" } });
  }

  const template = await readTemplateFor(dependencies.rest, companyId, row.template_invoice_id);

  return snapshotOf(row, template);
}

/**
 * The template's facts for a read, tolerant of a template that has since been issued.
 *
 * A create refuses a non-draft template because a new schedule must point at something that can still be
 * copied. A *read* cannot: a schedule that already exists keeps pointing at the invoice it was configured
 * with, and `0028` lets that invoice be issued and paid later. Refusing to show the schedule then would hide a
 * live schedule from the screen that exists to pause it.
 */
async function readTemplateFor(
  rest: RestClient,
  companyId: string,
  templateInvoiceId: string,
): Promise<RecurringScheduleTemplate> {
  const rows = await rest.select(
    "invoices",
    `select=id,client_id,status,total_minor,currency,number&id=eq.${templateInvoiceId}&company_id=eq.${companyId}`,
    templateRowSchema,
  );

  return (
    rows[0] ?? {
      id: templateInvoiceId,
      client_id: "",
      status: "",
      total_minor: "0",
      currency: "USD",
      number: null,
    }
  );
}

export const RECURRING_SCHEDULE_LIST_LIMIT = 50;

/** One merchant's schedules, newest first, with the row past the ceiling proving there are more. */
export async function listRecurringSchedules(
  input: { readonly actor: RequestActor },
  dependencies: Pick<RecurringScheduleDependencies, "rest">,
): Promise<{ readonly schedules: readonly RecurringScheduleSnapshot[]; readonly truncated: boolean }> {
  const companyId = requireRecurringActor(input.actor);
  const rows = await dependencies.rest.select(
    RECURRING_SCHEDULE_TABLE,
    `${RECURRING_SCHEDULE_COLUMNS}&company_id=eq.${companyId}&deleted_at=is.null&order=created_at.desc&limit=${String(RECURRING_SCHEDULE_LIST_LIMIT + 1)}`,
    recurringScheduleRowSchema,
  );

  const kept = rows.slice(0, RECURRING_SCHEDULE_LIST_LIMIT);
  const templates = new Map<string, RecurringScheduleTemplate>();

  // One read per distinct template, not one per row: a merchant's list is usually a handful of templates and
  // rule 17 forbids a query in a loop.
  for (const templateId of new Set(kept.map((row) => row.template_invoice_id))) {
    templates.set(templateId, await readTemplateFor(dependencies.rest, companyId, templateId));
  }

  return {
    schedules: kept.map((row) =>
      snapshotOf(row, templates.get(row.template_invoice_id) ?? emptyTemplate(row.template_invoice_id)),
    ),
    truncated: rows.length > RECURRING_SCHEDULE_LIST_LIMIT,
  };
}

function emptyTemplate(templateInvoiceId: string): RecurringScheduleTemplate {
  return { id: templateInvoiceId, client_id: "", status: "", total_minor: "0", currency: "USD", number: null };
}

/**
 * Edit the policy of one live schedule.
 *
 * Optimistic locking: the body carries the `version` the screen read, and a row that has moved on is a
 * conflict rather than a silent overwrite of whatever the other tab saved (rule 13).
 *
 * Two fields are deliberately not editable here. The template cannot change, because a schedule's document is
 * what the merchant configured and re-pointing it would silently change what a client is billed. `next_run_on`
 * cannot be typed either: it is the engine's answer, and a merchant who wants a different next run changes the
 * start date or the interval, which is the statement they actually mean.
 */
export async function updateRecurringSchedule(
  input: { readonly actor: RequestActor; readonly scheduleId: string; readonly body: unknown },
  dependencies: RecurringScheduleDependencies,
): Promise<RecurringScheduleSnapshot> {
  const companyId = requireRecurringActor(input.actor);

  if (!z.string().uuid().safeParse(input.scheduleId).success) {
    throw new AppError("VALIDATION_FAILED", { details: [{ field: "id", rule: "invalid_format" }] });
  }

  const parsed = recurringScheduleUpdateSchema.safeParse(input.body);

  if (!parsed.success) {
    throw problemsOf(parsed.error, [...UPDATE_FIELD_ORDER]);
  }

  const raw = parsed.data;
  const current = await readScheduleRow(dependencies.rest, companyId, input.scheduleId);
  const version = numberOf(raw.version);

  if (version === null) {
    throw new AppError("VALIDATION_FAILED", { details: [{ field: "version", rule: "invalid_format" }] });
  }

  if (version !== current.version) {
    throw new AppError("CONFLICT", {
      details: [{ field: "version", rule: "already_changed" }],
      cause: { rule: "recurring_schedule", reason: "stale_version" },
    });
  }

  // A paused or ended schedule is not edited: its interval has no meaning while it is not running, and
  // resuming it is the action that means "run this again".
  if (current.status !== RECURRING_SCHEDULE_CREATED_STATUS) {
    throw new AppError("VALIDATION_FAILED", {
      details: [{ field: "status", rule: current.status === "ended" ? "already_ended" : "invalid_format" }],
    });
  }

  const merged = mergeUpdate(current, raw);

  // The schedule may have already run, in which case its next run is a grid point from the anchor and not the
  // start date. Asking the engine keeps that one answer in one place.
  const nextRunOn = nextRunOf({
    startOn: merged.startOn,
    nextRunOn: current.next_run_on,
    endOn: merged.endOn,
    lastRunOn: current.last_run_on,
    intervalUnit: merged.intervalUnit,
    intervalCount: merged.intervalCount,
  });

  try {
    await dependencies.rest.update(
      RECURRING_SCHEDULE_TABLE,
      `id=eq.${input.scheduleId}&company_id=eq.${companyId}&status=eq.${RECURRING_SCHEDULE_CREATED_STATUS}&version=eq.${String(current.version)}`,
      {
        interval_unit: merged.intervalUnit,
        interval_count: merged.intervalCount,
        start_on: merged.startOn,
        next_run_on: nextRunOn,
        end_on: merged.endOn,
        terms_days: merged.termsDays,
        reminder_interval_days: merged.reminderIntervalDays,
        reminder_limit: merged.reminderLimit,
      },
    );
  } catch (error) {
    // A trigger's `raise exception` is a check_violation, which arrives as VALIDATION_FAILED. The only one an
    // update can earn is the template guard, and the template has not changed - so this is a genuine refusal
    // and is reported against the schedule rather than swallowed.
    if (error instanceof AppError && error.code === "VALIDATION_FAILED") {
      throw new AppError("VALIDATION_FAILED", { details: [{ field: "interval_unit", rule: "invalid_format" }] });
    }

    throw error;
  }

  // A PostgREST update that matched nothing still reports success, so the re-read is what turns a lost race
  // into a conflict rather than a screen that shows values the database never stored.
  const stored = await readScheduleRow(dependencies.rest, companyId, input.scheduleId);

  if (stored.version === current.version) {
    throw new AppError("CONFLICT", {
      details: [{ field: "version", rule: "already_changed" }],
      cause: { rule: "recurring_schedule", reason: "update_not_applied" },
    });
  }

  await appendTolerated(dependencies.audit, {
    action: RECURRING_SCHEDULE_UPDATED_AUDIT_ACTION,
    actorUserId: input.actor.userId,
    entityType: RECURRING_SCHEDULE_AUDIT_ENTITY,
    entityId: stored.id,
    companyId,
    sessionId: input.actor.sessionId ?? null,
    payload: {
      fields: changedFieldsOf(current, stored),
      next_run_on: stored.next_run_on,
      version: stored.version,
    },
  });

  return snapshotOf(stored, await readTemplateFor(dependencies.rest, companyId, stored.template_invoice_id));
}

/** The values an edit leaves as they were, with the body's own over the top. */
function mergeUpdate(
  current: RecurringScheduleRow,
  raw: z.infer<typeof recurringScheduleUpdateSchema>,
): {
  readonly intervalUnit: RecurringDateInput["intervalUnit"];
  readonly intervalCount: number;
  readonly startOn: string;
  readonly endOn: string | null;
  readonly termsDays: number;
  readonly reminderIntervalDays: number;
  readonly reminderLimit: number;
} {
  const problems: ErrorDetail[] = [];

  const unitRaw = raw.interval_unit === undefined || raw.interval_unit === null ? current.interval_unit : String(raw.interval_unit).trim();

  if (!isRecurringScheduleIntervalUnit(unitRaw)) {
    problems.push({ field: "interval_unit", rule: "invalid_format" });
  }

  const countRaw = raw.interval_count === undefined || raw.interval_count === null ? current.interval_count : numberOf(raw.interval_count);

  if (countRaw === null) {
    problems.push({ field: "interval_count", rule: "invalid_format" });
  } else {
    bounded(countRaw, RECURRING_SCHEDULE_COUNT_LIMITS, "interval_count", problems);
  }

  const startOn =
    raw.start_on === undefined || raw.start_on === null ? current.start_on : String(raw.start_on).trim();

  if (!isRecurringScheduleDate(startOn)) {
    problems.push({ field: "start_on", rule: "invalid_format" });
  }

  const endOn =
    raw.end_on === undefined
      ? current.end_on
      : raw.end_on === null || String(raw.end_on).trim().length === 0
        ? null
        : String(raw.end_on).trim();

  if (endOn !== null && !isRecurringScheduleDate(endOn)) {
    problems.push({ field: "end_on", rule: "invalid_format" });
  }

  const termsDays = raw.terms_days === undefined || raw.terms_days === null ? current.terms_days : numberOf(raw.terms_days);

  if (termsDays === null) {
    problems.push({ field: "terms_days", rule: "invalid_format" });
  } else {
    bounded(termsDays, RECURRING_SCHEDULE_TERMS_LIMITS, "terms_days", problems);
  }

  const reminderIntervalDays =
    raw.reminder_interval_days === undefined || raw.reminder_interval_days === null
      ? current.reminder_interval_days
      : numberOf(raw.reminder_interval_days);

  if (reminderIntervalDays === null) {
    problems.push({ field: "reminder_interval_days", rule: "invalid_format" });
  } else {
    bounded(reminderIntervalDays, RECURRING_SCHEDULE_REMINDER_INTERVAL_LIMITS, "reminder_interval_days", problems);
  }

  const reminderLimit =
    raw.reminder_limit === undefined || raw.reminder_limit === null ? current.reminder_limit : numberOf(raw.reminder_limit);

  if (reminderLimit === null) {
    problems.push({ field: "reminder_limit", rule: "invalid_format" });
  } else {
    bounded(reminderLimit, RECURRING_SCHEDULE_REMINDER_LIMIT_LIMITS, "reminder_limit", problems);
  }

  if (reminderIntervalDays !== null && reminderLimit !== null) {
    if (reminderIntervalDays === 0 && reminderLimit !== 0) {
      problems.push({ field: "reminder_limit", rule: "invalid_format" });
    } else if (reminderIntervalDays !== 0 && reminderLimit === 0) {
      problems.push({ field: "reminder_limit", rule: "too_small" });
    }
  }

  if (endOn !== null && isRecurringScheduleDate(startOn) && endOn < startOn) {
    problems.push({ field: "end_on", rule: "too_small" });
  }

  if (problems.length > 0) {
    throw new AppError("VALIDATION_FAILED", { details: problems });
  }

  return {
    intervalUnit: unitRaw as RecurringDateInput["intervalUnit"],
    intervalCount: countRaw ?? current.interval_count,
    startOn,
    endOn,
    termsDays: termsDays ?? current.terms_days,
    reminderIntervalDays: reminderIntervalDays ?? current.reminder_interval_days,
    reminderLimit: reminderLimit ?? current.reminder_limit,
  };
}

/** The fields an edit actually moved, so the trail says what changed rather than everything the row holds. */
function changedFieldsOf(before: RecurringScheduleRow, after: RecurringScheduleRow): readonly string[] {
  const fields: string[] = [];

  for (const column of [
    "interval_unit",
    "interval_count",
    "start_on",
    "next_run_on",
    "end_on",
    "terms_days",
    "reminder_interval_days",
    "reminder_limit",
  ] as const) {
    if (String(before[column] ?? "") !== String(after[column] ?? "")) {
      fields.push(column);
    }
  }

  return fields;
}

/**
 * Pause, resume or end one schedule.
 *
 * The three transitions are `0028`'s own paired checks: `paused_at` is set exactly when the status is
 * `paused`, `ended_at` exactly when it is `ended`. So each action writes the status and its instant in one
 * statement - which is what makes the column checks satisfiable, and what stops a pause from being recorded as
 * a status with no time.
 *
 * Ending is final. A merchant who wants the same schedule again creates one, because an ended schedule's
 * history is the invoices it produced and reanimating it would make `last_run_on` ambiguous.
 */
export async function setRecurringScheduleState(
  input: {
    readonly actor: RequestActor;
    readonly scheduleId: string;
    readonly action: "pause" | "resume" | "end";
    readonly version: number;
  },
  dependencies: RecurringScheduleDependencies,
): Promise<RecurringScheduleSnapshot> {
  const companyId = requireRecurringActor(input.actor);

  if (!z.string().uuid().safeParse(input.scheduleId).success) {
    throw new AppError("VALIDATION_FAILED", { details: [{ field: "id", rule: "invalid_format" }] });
  }

  if (!Number.isInteger(input.version) || input.version < 1) {
    throw new AppError("VALIDATION_FAILED", { details: [{ field: "version", rule: "invalid_format" }] });
  }

  const current = await readScheduleRow(dependencies.rest, companyId, input.scheduleId);

  if (input.version !== current.version) {
    throw new AppError("CONFLICT", {
      details: [{ field: "version", rule: "already_changed" }],
      cause: { rule: "recurring_schedule", reason: "stale_version" },
    });
  }

  const nowIso = new Date(dependencies.now?.() ?? Date.now()).toISOString();

  // What each action needs the schedule to be. Ending is refused while a row is already ended, and resuming is
  // refused once it has: an ended schedule is history, not a paused one.
  if (input.action === "resume" && current.status === "ended") {
    throw new AppError("VALIDATION_FAILED", { details: [{ field: "status", rule: "already_ended" }] });
  }

  if (input.action === "end" && current.status === "ended") {
    throw new AppError("VALIDATION_FAILED", { details: [{ field: "status", rule: "already_ended" }] });
  }

  const values: Record<string, unknown> =
    input.action === "pause"
      ? { status: "paused", paused_at: nowIso }
      : input.action === "resume"
        ? { status: RECURRING_SCHEDULE_CREATED_STATUS, paused_at: null }
        : { status: "ended", ended_at: nowIso, paused_at: null };

  try {
    await dependencies.rest.update(
      RECURRING_SCHEDULE_TABLE,
      `id=eq.${input.scheduleId}&company_id=eq.${companyId}&status=eq.${current.status}&version=eq.${String(current.version)}`,
      values,
    );
  } catch (error) {
    if (error instanceof AppError && error.code === "VALIDATION_FAILED") {
      throw new AppError("VALIDATION_FAILED", { details: [{ field: "status", rule: "invalid_format" }] });
    }

    throw error;
  }

  const stored = await readScheduleRow(dependencies.rest, companyId, input.scheduleId);

  if (stored.status === current.status) {
    throw new AppError("CONFLICT", {
      details: [{ field: "version", rule: "already_changed" }],
      cause: { rule: "recurring_schedule", reason: "state_not_applied" },
    });
  }

  const action =
    input.action === "pause"
      ? RECURRING_SCHEDULE_PAUSED_AUDIT_ACTION
      : input.action === "resume"
        ? RECURRING_SCHEDULE_RESUMED_AUDIT_ACTION
        : RECURRING_SCHEDULE_ENDED_AUDIT_ACTION;

  await appendTolerated(dependencies.audit, {
    action,
    actorUserId: input.actor.userId,
    entityType: RECURRING_SCHEDULE_AUDIT_ENTITY,
    entityId: stored.id,
    companyId,
    sessionId: input.actor.sessionId ?? null,
    payload: { from: current.status, to: stored.status, version: stored.version },
  });

  return snapshotOf(stored, await readTemplateFor(dependencies.rest, companyId, stored.template_invoice_id));
}

/** One live row of the actor's own merchant, or a 404 that does not say which merchant it was. */
async function readScheduleRow(
  rest: RestClient,
  companyId: string,
  scheduleId: string,
): Promise<RecurringScheduleRow> {
  const rows = await rest.select(
    RECURRING_SCHEDULE_TABLE,
    `${RECURRING_SCHEDULE_COLUMNS}&id=eq.${scheduleId}&company_id=eq.${companyId}&deleted_at=is.null`,
    recurringScheduleRowSchema,
  );
  const row = rows[0];

  if (row === undefined) {
    throw new AppError("RESOURCE_NOT_FOUND", { cause: { rule: "recurring_schedule", reason: "not_found" } });
  }

  return row;
}

/** The row as a screen sees it. Every instant crosses as epoch milliseconds and every amount as text. */
export function snapshotOf(
  row: RecurringScheduleRow,
  template: RecurringScheduleTemplate,
): RecurringScheduleSnapshot {
  if (!isRecurringScheduleStatus(row.status)) {
    throw new AppError("DEPENDENCY_FAILED", { cause: { rule: "recurring_schedule", reason: "unknown_status" } });
  }

  if (!isRecurringScheduleIntervalUnit(row.interval_unit)) {
    throw new AppError("DEPENDENCY_FAILED", { cause: { rule: "recurring_schedule", reason: "unknown_unit" } });
  }

  return {
    id: row.id,
    companyId: row.company_id,
    clientId: row.client_id,
    templateInvoiceId: row.template_invoice_id,
    status: row.status,
    intervalUnit: row.interval_unit,
    intervalCount: row.interval_count,
    startOn: row.start_on,
    nextRunOn: row.next_run_on,
    endOn: row.end_on,
    termsDays: row.terms_days,
    reminderIntervalDays: row.reminder_interval_days,
    reminderLimit: row.reminder_limit,
    lastRunOn: row.last_run_on,
    lastReminderOn: row.last_reminder_on,
    pausedAtEpochMs: row.paused_at === null ? null : Date.parse(row.paused_at),
    endedAtEpochMs: row.ended_at === null ? null : Date.parse(row.ended_at),
    template: {
      clientId: template.client_id,
      currency: template.currency,
      totalMinor: template.total_minor,
    },
    version: row.version,
    createdAtEpochMs: Date.parse(row.created_at),
    updatedAtEpochMs: Date.parse(row.updated_at),
  };
}

/** The role and the company, read from the session and never from the body. */
function requireRecurringActor(actor: RequestActor): string {
  requireAnyRole(actor, RECURRING_SCHEDULE_MANAGE_ROLES);

  return requireCompanyId(actor);
}

async function appendTolerated(audit: AuditTrail, entry: Parameters<AuditTrail["append"]>[0]): Promise<void> {
  try {
    await audit.append(entry);
  } catch {
    // An audit sink that is down never fails the write it records.
  }
}
