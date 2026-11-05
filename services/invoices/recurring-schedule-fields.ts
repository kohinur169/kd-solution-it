// path: services/invoices/recurring-schedule-fields.ts
/**
 * The vocabulary of section 16's recurring invoice: an interval, a due offset and a reminder policy.
 *
 * ## Why this file holds no behaviour
 *
 * Every constant here is a number, a word, a date pattern or a frozen list, and the two functions both start
 * with `is`. That is the promise `invoice-fields.ts` and `estimate-fields.ts` make: a browser file may import
 * this module without dragging a database client into its bundle, which is what lets a screen validate a form
 * with the same words the server refuses with.
 *
 * ## The bounds are copied from `0028`, and the gate checks that
 *
 * `0028_recurring_schedules.sql` states every bound as a named constraint - `recurring_schedules_count_check`
 * between 1 and 60, `recurring_schedules_terms_check` between 0 and 365, and so on. Those numbers are repeated
 * here rather than read from the schema at runtime, because a service has to refuse a bad value *before* a
 * round trip and a browser has to refuse it before that. The duplication is the risk, so `verify.ts` parses
 * the migration text and asserts that each constant below is the number the SQL actually declares: a bound
 * that drifted would be caught there rather than in production.
 */

/** `recurring_schedules_status_check`: the three states a schedule can be in. */
export const RECURRING_SCHEDULE_STATUSES = ["active", "paused", "ended"] as const;

export type RecurringScheduleStatus = (typeof RECURRING_SCHEDULE_STATUSES)[number];

/**
 * The status a new schedule is written with.
 *
 * `0028` declares `active` as the column default, and that is the right default here too: a merchant who has
 * finished configuring a schedule has said it should run. Pausing is an action on a schedule that exists, not
 * a state it has to be rescued from after being created.
 */
export const RECURRING_SCHEDULE_CREATED_STATUS: RecurringScheduleStatus = "active";

/** `recurring_schedules_unit_check`: what one interval step means. */
export const RECURRING_SCHEDULE_INTERVAL_UNITS = ["day", "week", "month", "year"] as const;

export type RecurringScheduleIntervalUnit = (typeof RECURRING_SCHEDULE_INTERVAL_UNITS)[number];

/**
 * The unit a new schedule starts on.
 *
 * `0028` defaults to `month` because that is what a retainer or a subscription almost always is, and a form
 * that opens on the common case saves the merchant a choice they would make correctly nine times in ten.
 */
export const RECURRING_SCHEDULE_DEFAULT_UNIT: RecurringScheduleIntervalUnit = "month";

/** `recurring_schedules_count_check`: how many units may sit between two runs. */
export const RECURRING_SCHEDULE_COUNT_LIMITS = Object.freeze({ min: 1, max: 60 });

/** `recurring_schedules_terms_check`: the due offset applied to each generated invoice, in days. */
export const RECURRING_SCHEDULE_TERMS_LIMITS = Object.freeze({ min: 0, max: 365 });

/** `0028` declares `terms_days` not null with a default of 30, which is the ordinary US net-30 term. */
export const RECURRING_SCHEDULE_DEFAULT_TERMS_DAYS = 30;

/** `recurring_schedules_reminder_interval_check`: days between reminders for one unpaid invoice. */
export const RECURRING_SCHEDULE_REMINDER_INTERVAL_LIMITS = Object.freeze({ min: 0, max: 90 });

/** `recurring_schedules_reminder_limit_check`: how many reminders one generated invoice may receive. */
export const RECURRING_SCHEDULE_REMINDER_LIMIT_LIMITS = Object.freeze({ min: 0, max: 10 });

/**
 * A date with no clock and no zone: `2026-11-05`.
 *
 * Every date on a schedule is one of these. `start_on`, `next_run_on`, `end_on`, `last_run_on` and
 * `last_reminder_on` are all `date` columns, and the reason is not stylistic: a schedule that stored an
 * instant would run at a different local time in March than in November, and a monthly invoice would drift
 * across the merchant's own calendar. A calendar date cannot drift, and `0028` says so by typing the columns
 * `date`. The same pattern and the same reasoning as `services/kyc/kyc-capture.ts`.
 */
export const RECURRING_SCHEDULE_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

/** A day, in milliseconds. Named because the engine does its arithmetic in days, never in seconds. */
export const RECURRING_SCHEDULE_DAY_MS = 86_400_000;

/**
 * Every way a schedule can be refused, as a rule a caller maps to a sentence.
 *
 * `already_used` is the template's unique index: `recurring_schedules_template_key` admits one live schedule
 * per template per merchant, so a second attempt on the same draft invoice answers as a conflict under that
 * name. The rest are this module's own judgements.
 */
export const RECURRING_SCHEDULE_RULES = [
  "required",
  "invalid_format",
  "too_small",
  "too_large",
  "unknown_field",
  "not_found",
  "already_used",
  "not_draft",
  "client_mismatch",
  "already_started",
  "already_ended",
  "absent",
] as const;

export type RecurringScheduleRule = (typeof RECURRING_SCHEDULE_RULES)[number];

/** Whether a string is one of the three statuses `0028` allows. */
export function isRecurringScheduleStatus(value: unknown): value is RecurringScheduleStatus {
  return typeof value === "string" && (RECURRING_SCHEDULE_STATUSES as readonly string[]).includes(value);
}

/** Whether a string is one of the four interval units `0028` allows. */
export function isRecurringScheduleIntervalUnit(value: unknown): value is RecurringScheduleIntervalUnit {
  return typeof value === "string" && (RECURRING_SCHEDULE_INTERVAL_UNITS as readonly string[]).includes(value);
}
